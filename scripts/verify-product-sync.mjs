/**
 * Product/inventory sync verification (webhooks + daily reconciliation pull).
 *
 * Proves, against a REAL booted app server + the real database:
 *   1. products/create webhook   -> local row created with REAL price/inventory
 *   2. products/update webhook   -> a webhook-triggered price change reflects
 *   3. "missed" webhook (stale row) + reconciliation pull -> corrected
 *   4. inventory_levels/update webhook -> single-item product updated directly
 *   5. products/delete webhook   -> row KEPT, flagged deleted_at, and no longer
 *      rankable (excluded from the live /api/proxy/rank candidate pool)
 *   6. reconciliation deletion sweep -> a local row absent from the (fake)
 *      catalog gets flagged (self-corrects a missed delete webhook)
 *   7. cadence gate -> once per UTC day per shop; failures never throw, never
 *      set the stamp, and the next call retries
 *
 * Usage: node scripts/verify-product-sync.mjs   (reads .env; boots the server)
 */
import process from "node:process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

// The sync module is PURE (db/admin injected, no runtime imports) so it can be
// driven directly here — same pattern as the thompson module tests.
import {
  upsertProductFromWebhook,
  reconcileShopProducts,
  ensureShopProductsReconciled,
} from "../app/utils/product-sync.server.ts";

process.loadEnvFile(".env");
const require = createRequire(import.meta.url);
const db = new PrismaClient();

const ROOT = process.cwd();
const PORT = process.env.VERIFY_PORT || 3791;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.SHOPIFY_API_SECRET;
if (!SECRET) {
  console.error("FATAL: SHOPIFY_API_SECRET missing from .env");
  process.exit(1);
}

const SHOP = `sync-e2e-${Date.now()}.myshopify.com`;
const SHOP2 = `sync-e2e-2-${Date.now()}.myshopify.com`;
const SHOP3 = `sync-e2e-3-${Date.now()}.myshopify.com`; // cadence failure path

const P1 = "9001001";
const P2 = "9001002";
const P3 = "9001003";
const ITEM1 = "777001";
const ITEM2 = "777002";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function printRow(label, row) {
  if (!row) {
    console.log(`    ${label}: <no row>`);
    return;
  }
  console.log(
    `    ${label}: price=${row.price} inv=${row.inventory_available}` +
      ` deleted_at=${row.deleted_at ? "SET" : "null"}` +
      ` items=[${(row.inventory_item_ids || []).join(",")}]`,
  );
}

// --- forged Shopify webhook (HMAC base64 over the exact raw body) ----------
async function sendWebhook(topic, payload) {
  const body = JSON.stringify(payload);
  const hmac = createHmac("sha256", SECRET).update(body).digest("base64");
  return fetch(`${BASE}/webhooks/${topic}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Webhook-Id": randomUUID(),
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Hmac-Sha256": hmac,
    },
    body,
  });
}

const variant = (id, price, inventory_quantity, inventory_item_id) => ({
  id,
  price,
  inventory_quantity,
  inventory_item_id,
});

async function getRow(product_id, shop = SHOP) {
  return db.products.findUnique({
    where: { product_id_shop_domain: { product_id, shop_domain: shop } },
  });
}

/**
 * Removes all synthetic state. Every FK cascades from shops (events,
 * experiment_assignments, products, product_surface_stats, rankings,
 * visitors), so deleting the shops rows clears everything this harness made.
 */
async function cleanup() {
  await db.shops.deleteMany({ where: { shop_domain: { in: [SHOP, SHOP2, SHOP3] } } });
  await db.products.deleteMany({
    where: { shop_domain: { in: [SHOP, SHOP2, SHOP3] } },
  });
}

// --- fake Admin API client (for reconciliation, no Shopify needed) ---------
function fakeAdmin(catalog) {
  // catalog: array of GraphQL-shaped product nodes (GID ids)
  let calls = 0;
  const client = {
    calls: () => calls,
    graphql: async () => {
      calls += 1;
      if (client.throwNext) {
        client.throwNext = false;
        throw new Error("simulated Admin API outage");
      }
      return {
        json: async () => ({
          data: {
            products: {
              edges: catalog.map((node) => ({ cursor: "c" + node.id, node })),
              pageInfo: { hasNextPage: false },
            },
          },
        }),
      };
    },
  };
  return client;
}
const gid = (n) => `gid://shopify/Product/${n}`;
const gqlVariant = (price, inventoryQuantity, itemId) => ({
  price: String(price),
  inventoryQuantity,
  inventoryItem: { id: `gid://shopify/InventoryItem/${itemId}` },
});

// --- server lifecycle (same pattern as verify-thompson-e2e) ----------------
let server = null;
async function startServer() {
  // ALWAYS rebuild: the webhook routes under test must be present in the
  // server bundle (a stale build/ silently 404s and would invalidate the run).
  const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
  if (built.status !== 0) throw new Error("npm run build failed");
  // Same launch path as verify-thompson-e2e.mjs: `npm run start` resolves the
  // @react-router/serve bin through the npm shim (the package is scoped —
  // node_modules/react-router-serve does not exist).
  server = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      // .env leaves SHOPIFY_APP_URL empty in dev; requireEnv() still needs it.
      SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true, // npm shim resolution on win32
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("server did not start within 90s");
}
function stopServer() {
  if (!server) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    // best effort
  }
}

async function main() {
  console.log(`\n=== Product/inventory sync verification ===`);
  console.log(`  shop: ${SHOP}\n`);

  await cleanup();
  await db.shops.create({ data: { shop_domain: SHOP, access_token: "sync-e2e-token", scopes: "read_products,write_products" } });

  console.log(`[boot] building + starting app server on port ${PORT} ...`);
  await startServer();
  console.log("  server is up\n");

  // --- 1. products/create webhook -----------------------------------------
  console.log("[1] products/create webhook (real HMAC-verified HTTP round-trip)");
  const createdResponse = await sendWebhook("products/create", {
    id: Number(P1),
    title: "Sync E2E Product 1",
    status: "active",
    created_at: new Date().toISOString(),
    variants: [variant(1, "19.99", 7, ITEM1)],
  });
  const row1 = await getRow(P1);
  printRow("after create webhook", row1);
  check("create webhook accepted (200)", createdResponse.status === 200, `status=${createdResponse.status}`);
  check("row CREATED with price=19.99", !!row1 && Number(row1.price) === 19.99, row1 && String(row1.price));
  check("inventory_available = 7 (real, non-zero)", !!row1 && row1.inventory_available === 7);
  check("not flagged deleted (active product)", !!row1 && row1.deleted_at === null);
  check("inventory_item_ids stored for later inventory-webhook resolution", !!row1 && row1.inventory_item_ids.join(",") === ITEM1);

  // --- 2. products/update webhook (webhook-triggered price change) ---------
  console.log("[2] products/update webhook — merchant changes the price intraday");
  printRow("before update webhook", await getRow(P1));
  await sendWebhook("products/update", {
    id: Number(P1),
    title: "Sync E2E Product 1",
    status: "active",
    created_at: new Date().toISOString(),
    variants: [variant(1, "29.99", 12, ITEM1)],
  });
  const after2 = await getRow(P1);
  printRow("after update webhook ", after2);
  check("webhook-triggered price change reflects locally (19.99 -> 29.99)", !!after2 && Number(after2.price) === 29.99);
  check("inventory change reflects too (7 -> 12)", !!after2 && after2.inventory_available === 12);

  // --- 3. missed webhook + reconciliation pull -----------------------------
  console.log("[3] MISSED webhook (stale row written directly) + reconciliation pull");
  await db.products.update({
    where: { product_id_shop_domain: { product_id: P1, shop_domain: SHOP } },
    data: { price: 5.0, inventory_available: 0 },
  });
  printRow("stale (missed webhook) ", await getRow(P1));
  const admin1 = fakeAdmin([
    { id: gid(P1), title: "Sync E2E Product 1", status: "ACTIVE", createdAt: new Date().toISOString(), variants: { edges: [{ node: gqlVariant(29.99, 12, ITEM1) }] } },
    { id: gid(P2), title: "Sync E2E Product 2", status: "ACTIVE", createdAt: new Date().toISOString(), variants: { edges: [{ node: gqlVariant(15.5, 3, ITEM2) }] } },
  ]);
  const reconcile1 = await reconcileShopProducts(db, SHOP, admin1);
  const corrected = await getRow(P1);
  const p2row = await getRow(P2);
  printRow("after reconciliation", corrected);
  printRow("P2 (catalog-only)    ", p2row);
  check("reconciliation ran (synced=2)", reconcile1.synced === 2, `synced=${reconcile1.synced}`);
  check("stale price CORRECTED by the pull (5.00 -> 29.99)", Number(corrected.price) === 29.99, String(corrected.price));
  check("stale inventory CORRECTED (0 -> 12)", corrected.inventory_available === 12);
  check("catalog-only product P2 pulled and created (15.50 / 3)", !!p2row && Number(p2row.price) === 15.5 && p2row.inventory_available === 3);
  check("GraphQL status ACTIVE (uppercase) still maps to not-deleted", !!p2row && p2row.deleted_at === null);

  // --- 4. inventory_levels/update webhook ----------------------------------
  console.log("[4] inventory_levels/update webhook (single-item product, direct write)");
  const invResponse = await sendWebhook("inventory_levels/update", { inventory_item_id: Number(ITEM1), available: 42 });
  const afterInv = await getRow(P1);
  printRow("after inventory webhook", afterInv);
  check("inventory webhook accepted (200)", invResponse.status === 200, `status=${invResponse.status}`);
  check("inventory resolved via stored item id and updated (12 -> 42)", !!afterInv && afterInv.inventory_available === 42);

  // --- 5. products/delete webhook: flagged, KEPT, unrankable live ----------
  console.log("[5] products/delete webhook — flagged (history kept), then unrankable live");
  await sendWebhook("products/delete", { id: Number(P1) });
  const deleted = await getRow(P1);
  printRow("after delete webhook ", deleted);
  check("row is KEPT (attribution history preserved), not deleted", !!deleted);
  check("row flagged deleted_at", !!deleted && deleted.deleted_at !== null);

  // Rankability, end-to-end: seed a collection instance holding the deleted
  // P1 and the live P2, then ask the REAL rank endpoint for a ranking.
  const treatVisitor = randomUUID();
  await db.visitors.create({ data: { visitor_id: treatVisitor, shop_domain: SHOP } });
  await db.experiment_assignments.create({
    data: {
      visitor_id: treatVisitor,
      shop_domain: SHOP,
      surface: "collection",
      surface_ref: "sync-check",
      experiment_id: randomUUID(),
      variant: "treatment",
      assigned_at: new Date(Date.now() - 86400_000),
    },
  });
  const impressions = [];
  for (let i = 0; i < 5; i++) {
    impressions.push({ visitor_id: treatVisitor, shop_domain: SHOP, event_type: "product_impression", product_id: P1, surface: "collection", surface_ref: "sync-check", occurred_at: new Date() });
  }
  for (let i = 0; i < 3; i++) {
    impressions.push({ visitor_id: treatVisitor, shop_domain: SHOP, event_type: "product_impression", product_id: P2, surface: "collection", surface_ref: "sync-check", occurred_at: new Date() });
  }
  await db.events.createMany({ data: impressions });

  // Signed rank request (same canonicalization as the thompson e2e harness).
  const signable = { visitor_id: treatVisitor, surface: "collection", surface_ref: "sync-check", shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) };
  const signKeys = Object.keys(signable).sort((a, b) => a.localeCompare(b));
  const signature = createHmac("sha256", SECRET).update(signKeys.map((k) => `${k}=${signable[k]}`).join("")).digest("hex");
  const rankResponse = await fetch(`${BASE}/api/proxy/rank?${new URLSearchParams({ ...signable, signature }).toString()}`);
  const rankJson = await rankResponse.json().catch(() => null);
  const ranking = rankJson && Array.isArray(rankJson.ranking) ? rankJson.ranking : null;
  console.log(`    live ranking: ${JSON.stringify(ranking)}`);
  check("rank request is 200 with a ranking", rankResponse.status === 200 && !!ranking && ranking.length > 0);
  check("DELETED product P1 is NOT rankable (excluded from the candidate pool)", !!ranking && !ranking.includes(P1));
  check("live P2 IS ranked", !!ranking && ranking.includes(P2));

  // --- 6. reconciliation deletion sweep -------------------------------------
  console.log("[6] reconciliation sweep — local row absent from the catalog gets flagged");
  printRow("P2 before sweep     ", await getRow(P2));
  const admin2 = fakeAdmin([
    { id: gid(P3), title: "Sync E2E Product 3", status: "ACTIVE", createdAt: new Date().toISOString(), variants: { edges: [{ node: gqlVariant(9.99, 5, "777003") }] } },
  ]);
  const sweep = await reconcileShopProducts(db, SHOP, admin2);
  const p2AfterSweep = await getRow(P2);
  const p3Row = await getRow(P3);
  printRow("P2 after sweep      ", p2AfterSweep);
  printRow("P3 (new from pull)  ", p3Row);
  check("sweep marked 1 product deleted (P2: missed delete webhook self-corrected)", sweep.markedDeleted === 1, `markedDeleted=${sweep.markedDeleted}`);
  check("P2 now flagged deleted_at", !!p2AfterSweep && p2AfterSweep.deleted_at !== null);
  check("P3 created from the pull (9.99 / 5)", !!p3Row && Number(p3Row.price) === 9.99 && p3Row.inventory_available === 5);

  // --- 7. cadence gate: once per UTC day per shop; failures never stamp -----
  console.log("[7] cadence gate — once per UTC day per shop; failures retry");
  await db.shops.create({
    data: { shop_domain: SHOP2, access_token: "sync-e2e-token-2", scopes: "read_products,write_products" },
  });
  const cadenceAdmin = fakeAdmin([
    { id: gid(P1), title: "Cadence Product", status: "ACTIVE", createdAt: new Date().toISOString(), variants: { edges: [{ node: gqlVariant(11.11, 2, ITEM1) }] } },
  ]);
  const firstGate = await ensureShopProductsReconciled(db, SHOP2, cadenceAdmin);
  const cadenceRow = await getRow(P1, SHOP2);
  const shop2 = await db.shops.findUnique({
    where: { shop_domain: SHOP2 },
    select: { products_reconciled_at: true },
  });
  printRow("SHOP2 pulled row    ", cadenceRow);
  check("first request of the day RAN the pull", firstGate.ran === true, `synced=${firstGate.synced}`);
  check(
    "pull created the row with real data (11.11 / 2)",
    !!cadenceRow && Number(cadenceRow.price) === 11.11 && cadenceRow.inventory_available === 2,
  );
  check("reconciliation stamp set (shops.products_reconciled_at)", !!shop2 && !!shop2.products_reconciled_at);
  const secondGate = await ensureShopProductsReconciled(db, SHOP2, cadenceAdmin);
  check("second request the SAME UTC day is SKIPPED", secondGate.ran === false);
  check("skipped request never hit the Admin API again", cadenceAdmin.calls() === 1, `calls=${cadenceAdmin.calls()}`);

  // Failure path: an Admin API outage must log loudly, never throw, and never
  // stamp the shop — so the next ranking request retries the pull.
  await db.shops.create({
    data: { shop_domain: SHOP3, access_token: "sync-e2e-token-3", scopes: "read_products,write_products" },
  });
  const outageAdmin = fakeAdmin([]);
  outageAdmin.throwNext = true;
  const failedGate = await ensureShopProductsReconciled(db, SHOP3, outageAdmin);
  const shop3 = await db.shops.findUnique({
    where: { shop_domain: SHOP3 },
    select: { products_reconciled_at: true },
  });
  check("outage does NOT throw (returns error flag)", failedGate.ran === false && failedGate.error === true);
  check("outage does NOT set the stamp (next request retries)", !!shop3 && shop3.products_reconciled_at === null);
  const retryGate = await ensureShopProductsReconciled(db, SHOP3, outageAdmin);
  check("next request retries and now runs the pull", retryGate.ran === true);

  // --- Summary --------------------------------------------------------------
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("\nFATAL:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    stopServer();
    try {
      await cleanup();
      console.log("[cleanup] synthetic shops removed.");
    } catch (error) {
      console.error("[cleanup] failed:", error instanceof Error ? error.message : error);
    }
    await db.$disconnect();
  });
