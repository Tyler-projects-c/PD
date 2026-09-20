/**
 * #4 follow-up: classify finalLinePrice discount behavior from a REAL checkout.
 *
 * The doc audit settled that CheckoutLineItem has no `cost` field (dead code
 * dropped) and the correct product path is variant.product — but whether
 * finalLinePrice INCLUDES order-level discount allocations is ambiguous in the
 * docs ("after line-level discounts have been applied"; Shopify's own example
 * reads the discount separately from discountAllocations). The only definitive
 * test is a real browser checkout through a discount.
 *
 * HOW TO RUN THE TEST:
 *   1. redeploy the pixel (shopify app deploy) so the variant.product fix is live
 *   2. start this watcher:  node scripts/watch-checkout-pixel.mjs
 *   3. place a real discounted checkout in the dev store browser
 *   4. this script polls the events table and, once the orders/paid webhook has
 *      verified the row, prints the verdict:
 *        - raw == verified_revenue, status=verified
 *            -> finalLinePrice INCLUDES order-level discounts; no alert noise
 *        - raw != verified_revenue, status=mismatch
 *            -> finalLinePrice EXCLUDES order-level discounts; every
 *               order-discounted checkout will alert -> apply the throttle
 *               decision (alert-throttle.server.ts) or reconsider
 *
 * DB-only (no Admin API): works even while the stored session token is stale.
 * Every synthetic row (idem-test-*, the #4 verify shop) is ignored — only rows
 * with a numeric order id from the real store are classified.
 *
 * Usage: node scripts/watch-checkout-pixel.mjs [timeout-seconds=600]
 */
import process from "node:process";
import { PrismaClient } from "@prisma/client";

process.loadEnvFile(".env");
const db = new PrismaClient();
const TIMEOUT_MS = (Number(process.argv[2]) || 600) * 1000;
const POLL_MS = 5000;
const startedAt = new Date();
/** The real dev store from shopify_sessions (the verify harness shop is excluded). */
const SHOP = (await db.$queryRaw`SELECT shop FROM shopify_sessions LIMIT 1`)[0].shop;

console.log("=== finalLinePrice discount-behavior watcher ===");
console.log("shop: " + SHOP);
console.log("waiting for a real checkout_completed row since " + startedAt.toISOString());
console.log("(place a real discounted checkout in the dev store now)");
console.log("");

const seen = new Map(); // event_id -> row (awaiting webhook verification)
let verdict = null;
const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline && !verdict) {
  const rows = await db.events.findMany({
    where: {
      shop_domain: SHOP,
      event_type: "checkout_completed",
      occurred_at: { gte: startedAt },
      order_id: { not: null },
    },
    orderBy: { occurred_at: "asc" },
  });
  for (const r of rows) {
    if (!/^\d+$/.test(String(r.order_id))) continue; // synthetic test rows
    if (!seen.has(r.event_id)) {
      seen.set(r.event_id, r);
      console.log(
        `  pixel row: order=${r.order_id} product=${r.product_id ?? "NULL"} raw_revenue=${r.revenue ?? "NULL"} status=${r.verification_status}`,
      );
      if (r.product_id === null || r.product_id === "") {
        console.log("    WARN: product_id is NULL - the deployed pixel predates the variant.product fix (redeploy needed)");
      }
    }
  }
  for (const [id, r] of seen) {
    if (r.verification_status === "pending") {
      const fresh = await db.events.findUnique({ where: { event_id: id } });
      if (fresh) seen.set(id, fresh);
    }
  }
  for (const [, r] of seen) {
    if (r.verification_status === "verified" || r.verification_status === "mismatch") {
      verdict = r;
      break;
    }
  }
  if (!verdict) await new Promise((res) => setTimeout(res, POLL_MS));
}

if (!verdict) {
  console.log("TIMEOUT: no classified checkout row within the window.");
  if (seen.size > 0) {
    console.log("Rows seen but still pending webhook verification:");
    for (const [, r] of seen) {
      console.log(`  order=${r.order_id} product=${r.product_id} raw=${r.revenue} status=${r.verification_status}`);
    }
  } else {
    console.log("No real checkout rows arrived - was the pixel redeployed and the checkout completed?");
  }
} else {
  const r = verdict;
  console.log("");
  console.log("=== VERDICT ===");
  console.log(`order=${r.order_id} product=${r.product_id} raw=${r.revenue} verified=${r.verified_revenue} status=${r.verification_status}`);
  if (r.verification_status === "verified") {
    console.log("finalLinePrice INCLUDES order-level discount allocations.");
    console.log("Pixel raw and webhook agree on discounted orders -> NO alert noise, no throttle needed.");
  } else {
    console.log("finalLinePrice EXCLUDES order-level discount allocations.");
    console.log("Every order-discounted checkout will fire a mismatch alert (revenue is still correct:");
    console.log("verified_revenue carries the authoritative webhook amount). Decide: throttle the");
    console.log("alert via alert-throttle.server.ts, or accept the noise as a review signal.");
  }
}

await db.$disconnect();
process.exit(verdict ? 0 : 2);
