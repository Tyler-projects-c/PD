/**
 * #6: GraphQL query cost, measured against the REAL Admin API on the dev store.
 *
 * This is NOT an analytical estimate. It imports the SAME document the app
 * ships (RECONCILE_QUERY from app/utils/product-sync.server.ts), sends it to
 * the shop's Admin API and prints the real `extensions.cost` numbers Shopify
 * returns. Because it talks to the live schema it also proves the document is
 * VALID: a bad selection (e.g. asking for a field on the wrong type) comes back
 * as a GraphQL error and this script FAILS loudly instead of passing a
 * fake-admin unit test.
 *
 * Auth: uses the stored offline session; if that token has been revoked it
 * exchanges the stored refresh token for a fresh access token (OAuth
 * token-exchange, no interactive login needed).
 *
 * Usage: node scripts/verify-graphql-cost.mjs
 * Env:   SHOPIFY_API_VERSION overrides the version under test (default 2026-07,
 *        the version app/shopify.server.ts pins).
 */
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import { RECONCILE_QUERY } from "../app/utils/product-sync.server.ts";

process.loadEnvFile(".env");
const prisma = new PrismaClient();

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const COST_LIMIT = 1000;

/** The pre-fix document, for a real before/after cost comparison. */
const LEGACY_QUERY = `query ProductSyncPage($after: String) {
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
}`;

let failures = 0;
function fail(msg) {
  failures++;
  console.log("  FAIL  " + msg);
}

async function getToken(session) {
  if (await probe(session.accessToken, "stored token", null, true)) return session.accessToken;
  if (!session.refreshToken) {
    console.log("  stored token rejected and no refresh token is available.");
    return null;
  }
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    console.log("  stored token rejected and SHOPIFY_API_KEY/SECRET are not set.");
    return null;
  }
  console.log("  exchanging the stored refresh token for a fresh access token...");
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
    console.log(
      "  token exchange failed: HTTP " + res.status + " " + (await res.text()).slice(0, 200),
    );
    return null;
  }
  const body = await res.json();
  console.log("  token exchange OK (expires_in=" + body.expires_in + "s)");
  return body.access_token;
}

/**
 * Send `document` once. When `quiet` is set nothing is printed (that call is
 * only testing whether the token works); otherwise the REAL cost numbers
 * Shopify reports are printed and the parsed result is returned.
 */
async function probe(token, label, document, quiet) {
  const url = "https://" + session.shop + "/admin/api/" + API_VERSION + "/graphql.json";
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document || RECONCILE_QUERY, variables: { after: null } }),
  });
  const body = await res.json().catch(() => ({}));
  if (quiet) return res.status === 200 && !body.errors;
  console.log("  --- " + label + " -> HTTP " + res.status);
  if (body.errors) {
    const first = Array.isArray(body.errors) ? body.errors[0] : body.errors;
    const message = typeof first === "string" ? first : first && first.message;
    console.log("      GraphQL error: " + message);
    return false;
  }
  const cost = body.extensions && body.extensions.cost;
  if (!cost) {
    console.log("      no extensions.cost in the response");
    return false;
  }
  const edges = (body.data && body.data.products && body.data.products.edges) || [];
  let variants = 0;
  for (const e of edges) {
    variants += ((e.node && e.node.variants && e.node.variants.edges) || []).length;
  }
  console.log("      requestedQueryCost: " + cost.requestedQueryCost);
  console.log("      actualQueryCost:    " + cost.actualQueryCost);
  console.log("      totalCost:          " + cost.totalCost);
  console.log("      returnCount:        " + cost.returnCount);
  console.log("      throttleStatus:     " + JSON.stringify(cost.throttleStatus || null));
  console.log("      rows returned:      " + edges.length + " products / " + variants + " variants");
  return { cost, products: edges.length, variants };
}

const rows = await prisma.$queryRaw`SELECT shop, "accessToken", "refreshToken" FROM shopify_sessions LIMIT 1`;
if (!rows.length) {
  console.error("FAIL: no session in the DB - install the app on the dev store first.");
  await prisma.$disconnect();
  process.exit(1);
}
const session = rows[0];
console.log("=== #6 GRAPHQL COST (REAL ADMIN API) ===");
console.log("shop: " + session.shop);
console.log("api version: " + API_VERSION);

const token = await getToken(session);
if (!token) {
  console.error("FAIL: could not obtain a usable admin token.");
  await prisma.$disconnect();
  process.exit(1);
}

console.log("");
console.log("[1] the document the app actually ships (25 products / 50 variants)");
const current = await probe(token, "RECONCILE_QUERY", null, false);
if (!current) {
  fail("the shipped query was REJECTED by the live schema (see the GraphQL error above)");
} else if (current.cost.requestedQueryCost > COST_LIMIT) {
  fail(
    "requestedQueryCost " + current.cost.requestedQueryCost +
      " exceeds the " + COST_LIMIT + " single-query limit",
  );
} else {
  console.log(
    "  PASS  requestedQueryCost " + current.cost.requestedQueryCost + " <= " + COST_LIMIT +
      " (headroom " + (COST_LIMIT - current.cost.requestedQueryCost) + ")",
  );
}

console.log("");
console.log("[2] the pre-fix document (250 products / 100 variants) for comparison");
const legacy = await probe(token, "LEGACY_QUERY", LEGACY_QUERY, false);
if (legacy) {
  if (legacy.cost.requestedQueryCost > COST_LIMIT) {
    console.log(
      "  NOTE  the legacy cost " + legacy.cost.requestedQueryCost + " exceeds " + COST_LIMIT +
        " - the page-size reduction in [1] is what removed that risk",
    );
  }
} else {
  console.log("  NOTE  the legacy document was rejected outright by the API");
}

console.log("");
console.log(failures === 0 ? "RESULT: PASS" : "RESULT: FAIL (" + failures + ")");
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);


