/**
 * Product/inventory sync — keeps products.price and products.inventory_available
 * populated and fresh. Two complementary channels, BOTH required:
 *
 *   1. WEBHOOK-DRIVEN (intraday): products/create, products/update,
 *      products/delete, inventory_levels/update (registered in
 *      shopify.app.toml; handlers in app/routes/webhooks.products.*.tsx and
 *      webhooks.inventory_levels.update.tsx). Each event upserts the affected
 *      product's price / inventory / inventory_item_ids in the local table.
 *
 *   2. PERIODIC RECONCILIATION (self-correction): a full-catalog Admin API
 *      pull, once per UTC day per shop, piggybacked on the first ranking
 *      request of the day via ensureShopProductsReconciled() (the same
 *      piggyback pattern as the daily stats rollup — this app has NO
 *      cron/scheduler, a prior verified decision). This exists specifically to
 *      repair anything a missed/failed webhook would leave stale: it upserts
 *      every product in the shop's catalog AND flags local rows that are
 *      absent from the catalog (missed delete webhooks) as deleted.
 *
 * DELETION SEMANTICS: a product deleted in Shopify (or draft/archived, or
 * absent from a reconciliation pull) is FLAGGED with products.deleted_at —
 * never deleted locally. products is the FK parent of product_surface_stats
 * (ON DELETE CASCADE): deleting rows would silently destroy attribution
 * history. buildCandidates() excludes flagged rows, so they are not rankable.
 *
 * INVENTORY CAVEAT (flagged): inventory_levels/update carries only ONE
 * inventory item's per-location count and no product id. Single-item products
 * (the common case) get the direct write; multi-item products cannot be summed
 * from one location event — the event is logged and the value is left to the
 * daily reconciliation, which sums variants' inventoryQuantity authoritatively.
 *
 * This module is PURE (no runtime imports): db and admin are injected, so the
 * verify harness (scripts/verify-product-sync.mjs) can drive it directly with
 * the real Prisma client and a fake Admin client.
 */

/** PrismaClient type only — erased at runtime (type stripping). */
import type { PrismaClient } from "@prisma/client";

const LOG = "[product-sync]";

/** Minimal shape of the authenticated Admin API client (admin.graphql). */
export interface AdminApiClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<any> }>;
}

/** Numeric id from a Shopify GID ("gid://shopify/Product/123" -> "123"). */
function idFromGid(gid: unknown): string {
  const match = String(gid ?? "").match(/(\d+)$/);
  return match ? match[1] : "";
}

function finiteNumber(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface NormalizedProduct {
  product_id: string;
  title: string;
  created_at: Date;
  price: number; // min variant price (cheapest purchasable unit)
  inventory_available: number; // sum across variants
  inventory_item_ids: string[];
  deleted_at: Date | null; // non-active == not purchasable == unrankable
}

/**
 * Normalize a product from EITHER a REST webhook payload (products/create,
 * products/update — variants carry price/inventory_quantity/inventory_item_id)
 * OR a GraphQL Admin product node (id is a GID; variants carry
 * price/inventoryQuantity/inventoryItem.id). One mapping, two transport shapes.
 */
function normalizeProduct(raw: any): NormalizedProduct | null {
  if (!raw) return null;
  const productId = idFromGid(raw.id) || (raw.id != null ? String(raw.id) : "");
  if (!productId) return null;

  const variants: any[] = Array.isArray(raw.variants)
    ? raw.variants // REST webhook shape: [{ id, price, inventory_quantity, inventory_item_id }]
    : Array.isArray(raw.variants?.edges)
      ? raw.variants.edges.map((e: any) => e?.node ?? {}) // GraphQL shape
      : [];

  const prices = variants
    .map((v) => finiteNumber(v?.price))
    .filter((p) => p > 0);
  const price = prices.length > 0 ? Math.min(...prices) : 0;

  const inventoryItemIds: string[] = [];
  let inventoryAvailable = 0;
  for (const v of variants) {
    // REST: inventory_item_id ; GraphQL: inventoryItem.id (GID).
    const itemId =
      idFromGid(v?.inventoryItem?.id) ||
      (v?.inventory_item_id != null ? String(v.inventory_item_id) : "");
    if (itemId) inventoryItemIds.push(itemId);
    // REST: inventory_quantity ; GraphQL: inventoryQuantity. Can be null when
    // tracking is off — treat as 0 (reconciliation keeps it authoritative).
    inventoryAvailable += Math.max(0, Math.trunc(finiteNumber(v?.inventory_quantity ?? v?.inventoryQuantity)));
  }

  // REST/webhook payloads send the lowercase status ("active"); the GraphQL
  // Admin API returns the uppercase ProductStatus enum ("ACTIVE", "DRAFT",
  // "ARCHIVED"). Normalize the case before comparing — a case-sensitive
  // check here silently flagged EVERY active product as deleted, which then
  // cascaded into buildCandidates() excluding the whole catalog (unrankable
  // shop) and into the reconciliation deletion sweep.
  const status = String(raw.status ?? "active").toLowerCase();
  const createdAtRaw = raw.created_at ?? raw.createdAt;

  return {
    product_id: productId,
    title: String(raw.title ?? ""),
    created_at: createdAtRaw ? new Date(createdAtRaw) : new Date(),
    price,
    inventory_available: inventoryAvailable,
    inventory_item_ids: inventoryItemIds,
    deleted_at: status === "active" ? null : new Date(),
  };
}

async function upsertNormalized(
  db: PrismaClient,
  shopDomain: string,
  product: NormalizedProduct,
): Promise<void> {
  const data = {
    title: product.title,
    created_at: product.created_at,
    price: product.price,
    inventory_available: product.inventory_available,
    inventory_item_ids: product.inventory_item_ids,
    deleted_at: product.deleted_at,
    last_synced_at: new Date(),
  };
  await db.products.upsert({
    where: { product_id_shop_domain: { product_id: product.product_id, shop_domain: shopDomain } },
    create: { product_id: product.product_id, shop_domain: shopDomain, ...data },
    update: data,
  });
}

/**
 * WEBHOOK: products/create | products/update — upsert one product's synced
 * fields from the REST payload. Callers wrap in try/catch and rethrow so
 * Shopify retries genuine failures.
 */
export async function upsertProductFromWebhook(
  db: PrismaClient,
  shopDomain: string,
  payload: unknown,
): Promise<string | null> {
  const product = normalizeProduct(payload);
  if (!product) {
    console.warn(`${LOG} ${shopDomain} products webhook payload has no recognizable product id; SKIPPED (no local write)`);
    return null;
  }
  if (product.price <= 0) {
    console.warn(
      `${LOG} ${shopDomain} product ${product.product_id} has no positive variant price in the webhook payload;` +
        ` storing price=0 (revenue weighting will fall back per its rules)`,
    );
  }
  await upsertNormalized(db, shopDomain, product);
  return product.product_id;
}

/**
 * WEBHOOK: products/delete — FLAG the row deleted (never delete: see module
 * doc). Missing local row is a no-op (nothing to flag).
 */
export async function markProductDeleted(
  db: PrismaClient,
  shopDomain: string,
  payload: unknown,
): Promise<string | null> {
  const raw = (payload ?? {}) as any;
  const productId = raw.id != null ? String(raw.id) : "";
  if (!productId) {
    console.warn(`${LOG} ${shopDomain} products/delete payload has no product id; SKIPPED`);
    return null;
  }
  const existing = await db.products.findUnique({
    where: { product_id_shop_domain: { product_id: productId, shop_domain: shopDomain } },
    select: { deleted_at: true },
  });
  if (!existing) {
    console.warn(`${LOG} ${shopDomain} products/delete for unknown product ${productId}; nothing to flag`);
    return null;
  }
  if (existing.deleted_at) {
    return productId; // already flagged; idempotent
  }
  await db.products.update({
    where: { product_id_shop_domain: { product_id: productId, shop_domain: shopDomain } },
    data: { deleted_at: new Date(), last_synced_at: new Date() },
  });
  return productId;
}

/**
 * WEBHOOK: inventory_levels/update — payload { inventory_item_id, available }.
 * Resolves the product LOCALLY via stored inventory_item_ids (no Admin API
 * round-trip). Single-item products get the direct write; multi-item products
 * cannot be summed from one per-location event — logged, left to the daily
 * reconciliation (which sums variant inventoryQuantity authoritatively).
 */
export async function handleInventoryLevelUpdate(
  db: PrismaClient,
  shopDomain: string,
  payload: unknown,
): Promise<{ product_id: string | null; updated: boolean }> {
  const raw = (payload ?? {}) as any;
  const itemId = raw.inventory_item_id != null ? String(raw.inventory_item_id) : "";
  const available = Math.max(0, Math.trunc(finiteNumber(raw.available)));
  if (!itemId) {
    console.warn(`${LOG} ${shopDomain} inventory_levels/update payload has no inventory_item_id; SKIPPED`);
    return { product_id: null, updated: false };
  }
  const product = await db.products.findFirst({
    where: { shop_domain: shopDomain, inventory_item_ids: { has: itemId } },
    select: { product_id: true, inventory_item_ids: true },
  });
  if (!product) {
    console.warn(
      `${LOG} ${shopDomain} inventory_levels/update for unknown inventory_item ${itemId};` +
        ` no local product maps to it — the daily reconciliation will cover this product`,
    );
    return { product_id: null, updated: false };
  }
  if (product.inventory_item_ids.length > 1) {
    console.warn(
      `${LOG} ${shopDomain} inventory update for multi-variant product ${product.product_id}` +
        ` (${product.inventory_item_ids.length} items) is location-scoped and not summable from one event;` +
        ` deferring to the daily reconciliation`,
    );
    return { product_id: product.product_id, updated: false };
  }
  await db.products.update({
    where: { product_id_shop_domain: { product_id: product.product_id, shop_domain: shopDomain } },
    data: { inventory_available: available, last_synced_at: new Date() },
  });
  return { product_id: product.product_id, updated: true };
}

const RECONCILE_QUERY = `#graphql
  query ProductSyncPage($after: String) {
    products(first: 250, after: $after, sortKey: ID) {
      edges {
        cursor
        node {
          id
          title
          status
          createdAt
          variants(first: 100) {
            edges {
              node {
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

/**
 * RECONCILIATION: full-catalog Admin API pull. Upserts EVERY product in the
 * shop's catalog (price/inventory/ids/status — this CREATES local rows for
 * products the shop has but we never saw a webhook for), flags local rows
 * ABSENT from the catalog as deleted (missed delete webhooks), and reports
 * counts. `admin` is the authenticated Admin API client (injected so the
 * verify harness can drive this without Shopify).
 */
export async function reconcileShopProducts(
  db: PrismaClient,
  shopDomain: string,
  admin: AdminApiClient,
): Promise<{ synced: number; markedDeleted: number }> {
  const seen = new Set<string>();
  let after: string | null = null;
  let pages = 0;

  for (;;) {
    pages += 1;
    if (pages > 100) {
      // >25,000 products: almost certainly a bug (wrong shop?), stop loudly.
      console.error(`${LOG} ${shopDomain} reconciliation exceeded 100 catalog pages; aborting pull (data so far still upserted)`);
      break;
    }
    const response = await admin.graphql(RECONCILE_QUERY, { variables: { after } });
    const body = await response.json();
    const connection = body?.data?.products;
    if (!connection || !Array.isArray(connection.edges)) {
      throw new Error(`unexpected Admin API response shape on products page ${pages}`);
    }
    for (const edge of connection.edges) {
      const product = normalizeProduct(edge?.node);
      if (!product) {
        console.warn(`${LOG} ${shopDomain} reconciliation page ${pages} has an unrecognizable product node; SKIPPED`);
        continue;
      }
      if (product.inventory_item_ids.length > 100) {
        console.warn(`${LOG} ${shopDomain} product ${product.product_id} has ${product.inventory_item_ids.length} variants; only the first 100 were pulled (webhooks + next run cover the rest)`);
      }
      await upsertNormalized(db, shopDomain, product);
      seen.add(product.product_id);
    }
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.edges[connection.edges.length - 1]?.cursor ?? null;
    if (!after) break;
  }

  // Missed-delete self-correction: local unflagged rows absent from the
  // catalog are deleted-in-Shopify as far as we can know — flag them.
  const localActive = await db.products.findMany({
    where: { shop_domain: shopDomain, deleted_at: null },
    select: { product_id: true },
  });
  const missing = localActive.filter((p) => !seen.has(p.product_id)).map((p) => p.product_id);
  if (missing.length > 0) {
    await db.products.updateMany({
      where: { shop_domain: shopDomain, product_id: { in: missing } },
      data: { deleted_at: new Date() },
    });
    console.warn(
      `${LOG} ${shopDomain} reconciliation flagged ${missing.length} local product(s) as deleted` +
        ` (absent from the Shopify catalog — likely missed delete webhooks)`,
    );
  }

  return { synced: seen.size, markedDeleted: missing.length };
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * CADENCE GATE: run the reconciliation pull at most ONCE per UTC day per shop
 * (stamp: shops.products_reconciled_at), piggybacked on the first ranking
 * request of the day. NEVER throws — a failed sync must not take ranking down
 * with it; failures log loudly and do NOT set the stamp, so the next ranking
 * request retries the pull.
 */
export async function ensureShopProductsReconciled(
  db: PrismaClient,
  shopDomain: string,
  admin: AdminApiClient,
): Promise<{ ran: boolean; synced?: number; markedDeleted?: number; error?: boolean }> {
  try {
    const shop = await db.shops.findUnique({
      where: { shop_domain: shopDomain },
      select: { products_reconciled_at: true },
    });
    if (!shop) {
      console.warn(`${LOG} ${shopDomain} not installed locally; skipping product reconciliation`);
      return { ran: false };
    }
    if (shop.products_reconciled_at && shop.products_reconciled_at >= todayUtcMidnight()) {
      return { ran: false }; // already reconciled today
    }
    const result = await reconcileShopProducts(db, shopDomain, admin);
    await db.shops.update({
      where: { shop_domain: shopDomain },
      data: { products_reconciled_at: new Date() },
    });
    console.log(`${LOG} ${shopDomain} daily reconciliation complete: synced=${result.synced} markedDeleted=${result.markedDeleted}`);
    return { ran: true, synced: result.synced, markedDeleted: result.markedDeleted };
  } catch (error) {
    // LOUD failure, no stamp: the next ranking request retries the pull.
    console.error(
      `${LOG} ${shopDomain} daily product reconciliation FAILED (will retry on next ranking request):`,
      error instanceof Error ? error.message : error,
    );
    return { ran: false, error: true };
  }
}
