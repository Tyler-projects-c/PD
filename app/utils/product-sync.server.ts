/**
 * Product/inventory sync — keeps products.price, products.inventory_available,
 * and products.always_available populated and fresh. Two complementary
 * channels, BOTH required:
 *
 *   1. WEBHOOK-DRIVEN (intraday): products/create, products/update,
 *      products/delete, inventory_levels/update (registered in
 *      shopify.app.toml; handlers in app/routes/webhooks.products.*.tsx and
 *      webhooks.inventory_levels.update.tsx). Each event upserts the affected
 *      product's price / inventory / inventory_item_ids / always_available in
 *      the local table.
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
 * INVENTORY TRACKING (issue #7): a product is "always available" — purchasable
 * regardless of inventory_available — when ANY variant is untracked
 * (inventoryItem.tracked == false, e.g. gift cards, digital goods, "don't
 * track inventory" products) OR continue-selling (inventoryPolicy == CONTINUE,
 * oversell allowed). Tracked + DENY-when-out-of-stock variants contribute
 * their real counts; the rollup only counts inventory that actually gates
 * purchase. always_available is stored on the product row and used by
 * buildCandidates() so genuinely-out-of-stock products are excluded while
 * untracked/continue-selling products remain rankable.
 *
 * This module is PURE (no runtime imports beyond the logger): db and admin
 * are injected, so the verify harness (scripts/verify-product-sync.mjs) can
 * drive it directly with the real Prisma client and a fake Admin client.
 */

/** PrismaClient type only — erased at runtime (type stripping). */
import type { PrismaClient } from "@prisma/client";
import { logError, logInfo, logWarn } from "./logger.server.ts";

const LOG = "[product-sync]";
const MODULE = "product-sync";

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

/** Variant shapes from GraphQL Admin API (Product.node.variants) and REST webhooks. */
export interface GraphqlVariant {
  price?: string;
  inventoryQuantity?: number | null;
  /// `tracked` lives on InventoryItem. `inventoryPolicy` does NOT exist on
  /// InventoryItem — the Admin API rejects that selection outright
  /// ("Field 'inventoryPolicy' doesn't exist on type 'InventoryItem'") — it is a
  /// ProductVariant field (DENY | CONTINUE) and must be queried at this level.
  inventoryItem?: { id?: string; tracked?: boolean };
  inventoryPolicy?: string | null;
}
export interface RestVariant {
  id?: string | number;
  price?: string;
  inventory_quantity?: number | null;
  inventory_item_id?: string | number;
  inventory_management?: string | null;
  tracked?: boolean;
  inventory_policy?: string | null;
}

interface NormalizedProduct {
  product_id: string;
  title: string;
  created_at: Date;
  price: number;
  inventory_available: number;
  inventory_item_ids: string[];
  deleted_at: Date | null;
  always_available: boolean;
}

/**
 * INVENTORY ROLLUP (issue #7): a product is "always available" when ANY
 * variant is untracked (inventoryItem.tracked == false) OR continue-selling
 * (inventoryPolicy == CONTINUE). Tracked + DENY variants contribute real counts.
 */
interface VariantInventoryFlags {
  quantity: number;
  alwaysAvailable: boolean;
}

/**
 * Is this variant's quantity actually tracked?
 *   - GraphQL: the flag is InventoryItem.tracked (boolean).
 *   - REST: ProductVariant.inventory_management is "shopify" when tracked and
 *     null when the merchant chose "don't track quantity", so a field that is
 *     PRESENT (even an explicit null) is authoritative.
 * Returns null only when the payload carries no signal at all. Unknown is NOT
 * treated as always-available: guessing would wrongly keep genuinely
 * out-of-stock products rankable.
 */
function variantTracked(v: GraphqlVariant | RestVariant): boolean | null {
  const direct = (v as { tracked?: unknown }).tracked;
  if (typeof direct === "boolean") return direct;
  const item = (v as { inventoryItem?: { tracked?: unknown } }).inventoryItem;
  if (item && typeof item.tracked === "boolean") return item.tracked;
  if ("inventory_management" in (v as object)) {
    const management = (v as { inventory_management?: unknown }).inventory_management;
    return typeof management === "string" && management.trim().toLowerCase() === "shopify";
  }
  return null;
}

function variantInventoryFlags(v: GraphqlVariant | RestVariant): VariantInventoryFlags {
  const tracked = variantTracked(v);
  // GraphQL returns the policy as ProductVariant.inventoryPolicy; REST webhooks
  // send the same value as inventory_policy.
  const policyRaw =
    (v as { inventoryPolicy?: unknown }).inventoryPolicy ??
    (v as { inventory_policy?: unknown }).inventory_policy;
  const policy =
    typeof policyRaw === "string" ? policyRaw.trim().toUpperCase() : null;
  const alwaysAvailable = tracked === false || policy === "CONTINUE";
  const inventoryQuantityRaw =
    (v as { inventoryQuantity?: unknown }).inventoryQuantity !== undefined
      ? (v as { inventoryQuantity?: unknown }).inventoryQuantity
      : (v as { inventory_quantity?: unknown }).inventory_quantity;
  const quantity =
    inventoryQuantityRaw === null || inventoryQuantityRaw === undefined
      ? 0
      : Math.max(0, Math.floor(Number(inventoryQuantityRaw) || 0));
  return { quantity, alwaysAvailable };
}

function normalizeProduct(raw: any): NormalizedProduct | null {
  if (!raw) return null;
  const productId = idFromGid(raw.id) || (raw.id != null ? String(raw.id) : "");
  if (!productId) return null;
  const variants: any[] = Array.isArray(raw.variants)
    ? raw.variants
    : Array.isArray(raw.variants?.edges)
      ? raw.variants.edges.map((e: any) => e?.node ?? {})
      : [];
  const prices = variants.map((v) => finiteNumber(v?.price)).filter((p) => p > 0);
  const price = prices.length > 0 ? Math.min(...prices) : 0;
  const inventoryItemIds: string[] = [];
  let inventoryAvailable = 0;
  let alwaysAvailable = false;
  for (const v of variants) {
    const itemId =
      idFromGid(v?.inventoryItem?.id) ||
      (v?.inventory_item_id != null ? String(v.inventory_item_id) : "");
    if (itemId) inventoryItemIds.push(itemId);
    const flags = variantInventoryFlags(v);
    if (flags.alwaysAvailable) alwaysAvailable = true;
    inventoryAvailable += flags.quantity;
  }
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
    always_available: alwaysAvailable,
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
    always_available: product.always_available,
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
 * fields from the REST payload.
 */
export async function upsertProductFromWebhook(
  db: PrismaClient,
  shopDomain: string,
  payload: unknown,
): Promise<string | null> {
  const product = normalizeProduct(payload);
  if (!product) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} products webhook payload has no recognizable product id; SKIPPED (no local write)`,
    );
    return null;
  }
  if (product.price <= 0) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
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
  const productId = String(raw.id ?? "");
  if (!productId) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} products/delete payload has no product id; SKIPPED`,
    );
    return null;
  }
  const existing = await db.products.findUnique({
    where: { product_id_shop_domain: { product_id: productId, shop_domain: shopDomain } },
    select: { deleted_at: true },
  });
  if (!existing) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} products/delete for unknown product ${productId}; nothing to flag`,
    );
    return null;
  }
  if (existing.deleted_at) {
    return productId;
  }
  await db.products.update({
    where: { product_id_shop_domain: { product_id: productId, shop_domain: shopDomain } },
    data: { deleted_at: new Date(), last_synced_at: new Date() },
  });
  return productId;
}

/**
 * WEBHOOK: inventory_levels/update — payload { inventory_item_id, available }.
 */
export async function handleInventoryLevelUpdate(
  db: PrismaClient,
  shopDomain: string,
  payload: unknown,
): Promise<{ product_id: string | null; updated: boolean }> {
  const raw = (payload ?? {}) as any;
  const itemId = String(raw.inventory_item_id ?? "");
  const available = Math.max(0, Math.trunc(finiteNumber(raw.available)));
  if (!itemId) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} inventory_levels/update payload has no inventory_item_id; SKIPPED`,
    );
    return { product_id: null, updated: false };
  }
  const product = await db.products.findFirst({
    where: { shop_domain: shopDomain, inventory_item_ids: { has: itemId } },
    select: { product_id: true, inventory_item_ids: true },
  });
  if (!product) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} inventory_levels/update for unknown inventory_item ${itemId};` +
        ` no local product maps to it — the daily reconciliation will cover this product`,
    );
    return { product_id: null, updated: false };
  }
  if (product.inventory_item_ids.length > 1) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
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

/**
 * The reconciliation pull's GraphQL document, exported so the cost probe
 * (scripts/verify-graphql-cost.mjs) measures the REAL production query rather
 * than a copy that can silently drift out of sync with it.
 *
 * `inventoryPolicy` is selected on the VARIANT (ProductVariant), NOT inside
 * `inventoryItem`: InventoryItem has no such field and the API rejects the
 * whole query when it is asked for there.
 */
export const RECONCILE_QUERY = `#graphql
  query ProductSyncPage($after: String) {
    products(first: 25, after: $after, sortKey: ID) {
      edges {
        cursor
        node {
          id
          title
          status
          createdAt
          variants(first: 50) {
            edges {
              node {
                price
                inventoryQuantity
                inventoryPolicy
                inventoryItem {
                  id
                  tracked
                }
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
 * shop's catalog AND flags local rows ABSENT from the catalog as deleted.
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
      logError(
        { module: MODULE, shop_domain: shopDomain },
        `${LOG} ${shopDomain} reconciliation exceeded 100 catalog pages; aborting pull (data so far still upserted)`,
      );
      break;
    }
    const response = await admin.graphql(RECONCILE_QUERY, { variables: { after } });
    const body = await response.json();
    const connection = body?.data?.products;
    if (!connection || !Array.isArray(connection?.edges)) {
      throw new Error(`unexpected Admin API response shape on products page ${pages}`);
    }
    for (const edge of connection.edges) {
      const product = normalizeProduct(edge?.node);
      if (!product) {
        logWarn(
          { module: MODULE, shop_domain: shopDomain },
          `${LOG} ${shopDomain} reconciliation page ${pages} has an unrecognizable product node; SKIPPED`,
        );
        continue;
      }
      await upsertNormalized(db, shopDomain, product);
      seen.add(product.product_id);
    }
    if (!connection.pageInfo?.hasNextPage) break;
    after = connection.edges[connection.edges.length - 1]?.cursor ?? null;
    if (!after) break;
  }
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
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
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
 * request of the day. NEVER throws.
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
      logWarn(
        { module: MODULE, shop_domain: shopDomain },
        `${LOG} ${shopDomain} not installed locally; skipping product reconciliation`,
        { sentry: true, extra: { unknown_shop: true } },
      );
      return { ran: false };
    }
    if (shop.products_reconciled_at && shop.products_reconciled_at >= todayUtcMidnight()) {
      return { ran: false };
    }
    const result = await reconcileShopProducts(db, shopDomain, admin);
    await db.shops.update({
      where: { shop_domain: shopDomain },
      data: { products_reconciled_at: new Date() },
    });
    logInfo(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} daily reconciliation complete: synced=${result.synced} markedDeleted=${result.markedDeleted}`,
    );
    return { ran: true, synced: result.synced, markedDeleted: result.markedDeleted };
  } catch (error) {
    logError(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} daily product reconciliation FAILED (will retry on next ranking request)`,
      error,
    );
    return { ran: false, error: true };
  }
}
