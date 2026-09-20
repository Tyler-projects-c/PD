/**
 * #7 LIVE end-to-end verification, against the REAL dev store + REAL Admin API.
 *
 * The offline harness (scripts/verify-product-sync.mjs) drives the sync with a
 * FAKE admin client, so it cannot catch a bad GraphQL selection. This script
 * closes that hole: it builds a real AdminApiClient, runs the SHIPPED entry
 * point reconcileShopProducts() (so the shipped RECONCILE_QUERY is what talks to
 * Shopify), then re-derives the truth with an INDEPENDENT query and compares.
 *
 * Checks:
 *   1. the shipped document is accepted by the live schema
 *   2. products.always_available matches the rule (any variant untracked OR
 *      continue-selling) for EVERY product in the dev catalog
 *   3. products.inventory_available equals the real variant quantity rollup
 *   4. concrete proof for the catalog's untracked / continue-selling products
 *      (gift cards etc.) that they are now rankable, and that a genuinely
 *      out-of-stock tracked+DENY product stays unrankable
 *
 * Usage: node scripts/verify-inventory-tracking-live.mjs
 */
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { reconcileShopProducts } from "../app/utils/product-sync.server.ts";

process.loadEnvFile(".env");
const prisma = new PrismaClient();
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name + (detail ? " - " + detail : ""));
  } else {
    fail++;
    console.log("  FAIL  " + name + (detail ? " - " + detail : ""));
  }
}

/** Independent ground-truth document (deliberately NOT the shipped one). */
const TRUTH_QUERY = `query TruthPage($after: String) {
  products(first: 100, after: $after) {
    edges {
      cursor
      node {
        id
        title
        status
        variants(first: 100) {
          edges {
            node {
              price
              inventoryQuantity
              inventoryPolicy
              inventoryItem { id tracked }
            }
          }
        }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

async function getToken(session) {
  async function works(token) {
    const res = await fetch("https://" + session.shop + "/admin/api/" + API_VERSION + "/graphql.json", {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    });
    const body = await res.json().catch(() => ({}));
    return res.status === 200 && !body.errors;
  }
  if (await works(session.accessToken)) return session.accessToken;
  console.log("  stored token rejected; exchanging the refresh token...");
  const res = await fetch("https://" + session.shop + "/admin/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });
  if (!res.ok) {
    console.log("  token exchange failed: HTTP " + res.status);
    return null;
  }
  return (await res.json()).access_token;
}

const rows = await prisma.$queryRaw`SELECT shop, "accessToken", "refreshToken" FROM shopify_sessions LIMIT 1`;
if (!rows.length) {
  console.error("FAIL: no session in the DB.");
  await prisma.$disconnect();
  process.exit(1);
}
const session = rows[0];
const SHOP = session.shop;
console.log("=== #7 LIVE inventory-tracking verification ===");
console.log("shop: " + SHOP + " (api " + API_VERSION + ")");

const token = await getToken(session);
if (!token) {
  console.error("FAIL: no usable admin token.");
  await prisma.$disconnect();
  process.exit(1);
}
console.log("  admin token acquired.");

/** The real AdminApiClient shape reconcileShopProducts() expects. */
const admin = {
  graphql: async (query, options) => {
    const res = await fetch("https://" + SHOP + "/admin/api/" + API_VERSION + "/graphql.json", {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: (options && options.variables) || {} }),
    });
    const body = await res.json();
    return {
      json: async () => body,
      __status: res.status,
    };
  },
};

// ------------------------------------------------------------------ 1
console.log("");
console.log("[1] the SHIPPED RECONCILE_QUERY against the live schema (via reconcileShopProducts)");
const synced = await reconcileShopProducts(prisma, SHOP, admin);
check(
  "reconcileShopProducts completed against the real Admin API",
  typeof synced.synced === "number" && synced.synced > 0,
  "synced=" + synced.synced + " markedDeleted=" + synced.markedDeleted,
);

// ------------------------------------------------------------------ 2
console.log("");
console.log("[2] independent ground truth (separate query) vs what the sync stored");
const truth = [];
let after = null;
for (;;) {
  const res = await admin.graphql(TRUTH_QUERY, { variables: { after } });
  const body = await res.json();
  if (body.errors) {
    check("the independent truth query is accepted", false, JSON.stringify(body.errors).slice(0, 240));
    break;
  }
  const conn = body.data.products;
  for (const edge of conn.edges) {
    const node = edge.node;
    const variants = (node.variants.edges || []).map((e) => e.node);
    const untracked = variants.filter((v) => v.inventoryItem && v.inventoryItem.tracked === false);
    const continueSelling = variants.filter(
      (v) => String(v.inventoryPolicy || "").toUpperCase() === "CONTINUE",
    );
    const quantity = variants.reduce(
      (sum, v) => sum + Math.max(0, Number(v.inventoryQuantity) || 0),
      0,
    );
    truth.push({
      id: String(node.id).split("/").pop(),
      title: node.title,
      status: String(node.status || "").toLowerCase(),
      variants: variants.length,
      untracked: untracked.length,
      continueSelling: continueSelling.length,
      quantity,
      expectedAlways: untracked.length > 0 || continueSelling.length > 0,
    });
  }
  if (!conn.pageInfo.hasNextPage) break;
  after = conn.edges[conn.edges.length - 1].cursor;
  if (!after) break;
}

const stored = await prisma.products.findMany({
  where: { shop_domain: SHOP },
  select: {
    product_id: true,
    title: true,
    inventory_available: true,
    always_available: true,
    deleted_at: true,
  },
});
const byId = new Map(stored.map((p) => [p.product_id, p]));
check(
  "the sync stored every product the store reports",
  truth.every((t) => byId.has(t.id)),
  "store=" + truth.length + " stored=" + stored.length,
);

const alwaysMismatch = truth.filter((t) => {
  const row = byId.get(t.id);
  return row && row.always_available !== t.expectedAlways;
});
check(
  "always_available matches the rule for EVERY product",
  alwaysMismatch.length === 0,
  alwaysMismatch.length
    ? JSON.stringify(alwaysMismatch.slice(0, 5))
    : truth.length + " products checked",
);

const qtyMismatch = truth.filter((t) => {
  const row = byId.get(t.id);
  return row && row.inventory_available !== t.quantity;
});
check(
  "inventory_available equals the real variant quantity rollup",
  qtyMismatch.length === 0,
  qtyMismatch.length ? JSON.stringify(qtyMismatch.slice(0, 5)) : truth.length + " products checked",
);

// ------------------------------------------------------------------ 3
console.log("");
console.log("[3] concrete evidence from THIS catalog");
const untrackedRows = truth.filter((t) => t.untracked > 0);
const continueRows = truth.filter((t) => t.continueSelling > 0);
const outOfStock = truth.filter((t) => t.quantity === 0 && !t.expectedAlways);
console.log("  untracked-variant products (inventoryItem.tracked=false): " + untrackedRows.length);
for (const t of untrackedRows.slice(0, 6)) {
  console.log(
    "    - " + t.title + " | variants=" + t.variants + " untracked=" + t.untracked +
      " qty=" + t.quantity + " | stored always_available=" + (byId.get(t.id) || {}).always_available,
  );
}
console.log("  continue-selling products (inventoryPolicy=CONTINUE): " + continueRows.length);
for (const t of continueRows.slice(0, 6)) {
  console.log(
    "    - " + t.title + " | variants=" + t.variants + " continue=" + t.continueSelling +
      " qty=" + t.quantity + " | stored always_available=" + (byId.get(t.id) || {}).always_available,
  );
}
console.log("  genuinely out-of-stock (qty 0, tracked+DENY): " + outOfStock.length);
for (const t of outOfStock.slice(0, 6)) {
  console.log(
    "    - " + t.title + " | stored always_available=" + (byId.get(t.id) || {}).always_available,
  );
}
check(
  "untracked products are marked always_available",
  untrackedRows.every((t) => (byId.get(t.id) || {}).always_available === true),
  untrackedRows.length + " untracked product(s)",
);
check(
  "out-of-stock tracked products are NOT marked always_available",
  outOfStock.every((t) => (byId.get(t.id) || {}).always_available === false),
  outOfStock.length + " out-of-stock product(s)",
);

// ------------------------------------------------------------------ 4
console.log("");
console.log("[4] effect on the candidate filter (inventory_available > 0 OR always_available)");
const rankable = stored.filter(
  (p) => p.deleted_at === null && (p.inventory_available > 0 || p.always_available),
);
const excluded = stored.filter(
  (p) => p.deleted_at === null && p.inventory_available <= 0 && !p.always_available,
);
console.log("  rankable now: " + rankable.length + " | excluded as unavailable: " + excluded.length);
check(
  "untracked/continue-selling products survive the filter",
  truth.filter((t) => t.expectedAlways).every((t) => rankable.some((r) => r.product_id === t.id)),
  truth.filter((t) => t.expectedAlways).length + " always-available product(s)",
);
check(
  "no-stock products without the flag are excluded",
  outOfStock.every((t) => excluded.some((e) => e.product_id === t.id)),
  outOfStock.length + " out-of-stock product(s)",
);

console.log("");
console.log(
  fail === 0 ? "RESULT: " + pass + " passed, 0 failed" : "RESULT: " + pass + " passed, " + fail + " FAILED",
);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);



