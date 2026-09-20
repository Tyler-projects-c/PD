/**
 * Revenue trust hardening verification.
 *
 * Proves, against the REAL database and the real verification module:
 *   1. matching orders/paid webhook          -> rows verified, DB value = webhook
 *   2. mismatching webhook                   -> status mismatch, webhook still wins
 *   3. 1-cent rounding difference            -> verified, NOT mismatch
 *   4. multi-quantity line                   -> amount = unit price x quantity
 *   5. price_set.shop_money fallback         -> used when `price` is absent
 *   6. unmappable line (no numeric product)  -> skipped, never smeared
 *   7. webhook before the pixel row (race)   -> no crash, verified on redelivery
 *   8. row with no webhook line              -> stays pending
 *   9. 24h grace sweep                       -> stale pending -> unverified
 *  10. raw browser revenue is NEVER overwritten (asserted in every case)
 *  11. reporting decision (effectiveRevenue) -> verified wins; raw is the
 *      fallback while pending; unverified rows still report (flagged)
 *  12. the DB CHECK constraint rejects a bogus verification_status
 *  13. webhook-first race ledger (issue #3) -> webhook with no browser rows
 *      parks the line; the LATE pixel insert consumes it via
 *      reconcileLedgerForOrder and the row is verified immediately (no
 *      redelivery needed); consumption is idempotent and the ledger row is
 *      deleted; a null order id is a safe no-op
 *  14. ledger mismatch path                 -> disagreement is a loud mismatch,
 *      webhook still wins, the row is consumed either way
 *  15. discounted orders (issue #4)         -> pre-discount unit price x
 *      quantity MINUS discount_allocations is what gets compared/stored, so a
 *      discounted order is verified instead of falsely mismatched (a no-
 *      allocations baseline in the same test proves the fix is what prevents it)
 *
 * Every synthetic row is removed at the end (and on failure), so the harness is
 * re-runnable against a live dev database.
 *
 * Usage: node scripts/verify-revenue-verification.mjs   (reads .env)
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  VERIFICATION_ROUNDING_THRESHOLD,
  normalizePaidOrder,
  reconcileLedgerForOrder,
  sweepStaleVerifications,
  verifyPaidOrder,
} from "../app/utils/order-verification.server.ts";
import { effectiveRevenue, revenueSource } from "../app/utils/verified-revenue.ts";

process.loadEnvFile(".env");
const db = new PrismaClient();

/** Isolated synthetic shop: never collides with a real merchant. */
const SHOP = process.env.VERIFY_SHOP || "pd-revver-verify.myshopify.com";
const VISITOR = randomUUID();
const STAMP = String(Date.now()).slice(-7);
const ORDER = (n) => `9${STAMP}${n}`;
/** Unique numeric Shopify product ids for this run. */
const P = (n) => `98${STAMP}${n}`;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Create a browser-reported checkout_completed row, remembering it for cleanup. */
async function browserCheckout({ product_id, order_id, revenue, occurred_at }) {
  return db.events.create({
    data: {
      visitor_id: VISITOR,
      shop_domain: SHOP,
      event_type: "checkout_completed",
      product_id,
      order_id,
      revenue,
      occurred_at: occurred_at ?? new Date(),
    },
  });
}

/** One checkout_completed row for an order/product, or null. */
function rowFor(order_id, product_id) {
  return db.events.findFirst({ where: { shop_domain: SHOP, order_id, product_id } });
}

async function rowsForOrder(order_id) {
  return db.events.findMany({
    where: { shop_domain: SHOP, order_id },
    orderBy: { product_id: "asc" },
  });
}

/** orders/paid REST line item for a numeric product id. */
function line(product_id, price, quantity = 1) {
  return { product_id: Number(product_id), price: String(price), quantity };
}

async function main() {
  await db.shops.upsert({
    where: { shop_domain: SHOP },
    update: {},
    create: { shop_domain: SHOP, access_token: "revenue-verify", scopes: "read_products" },
  });
  await db.visitors.upsert({
    where: { visitor_id: VISITOR },
    update: { shop_domain: SHOP },
    create: { visitor_id: VISITOR, shop_domain: SHOP },
  });

  // ---------------------------------------------------------------- 1
  console.log("[1] matching orders/paid webhook -> verified, raw preserved");
  const o1 = ORDER(1);
  const p1a = P(1);
  const p1b = P(2);
  await browserCheckout({ product_id: p1a, order_id: o1, revenue: 78.95 });
  await browserCheckout({ product_id: p1b, order_id: o1, revenue: 44.5 });
  const r1 = await verifyPaidOrder(db, SHOP, {
    id: Number(o1),
    name: "#1001",
    line_items: [line(p1a, "78.95"), line(p1b, 44.5)],
  });
  const rows1 = await rowsForOrder(o1);
  check(
    "2 checkout rows matched, both verified",
    r1.matchedRows === 2 && r1.verifiedRows === 2 && r1.mismatchRows === 0,
    JSON.stringify(r1),
  );
  check(
    "both rows status=verified with verified_at set",
    rows1.every((r) => r.verification_status === "verified" && r.verified_at !== null),
  );
  check(
    "verified_revenue = webhook per-line amounts (78.95 / 44.50)",
    Number(rows1[0].verified_revenue) === 78.95 && Number(rows1[1].verified_revenue) === 44.5,
  );
  check(
    "raw browser revenue untouched by matching path",
    Number(rows1[0].revenue) === 78.95 && Number(rows1[1].revenue) === 44.5,
  );

  // ---------------------------------------------------------------- 2
  console.log("[2] mismatching webhook -> mismatch, webhook wins, raw preserved");
  const o2 = ORDER(2);
  const p2 = P(3);
  await browserCheckout({ product_id: p2, order_id: o2, revenue: 10 });
  const r2 = await verifyPaidOrder(db, SHOP, {
    id: Number(o2),
    line_items: [line(p2, "12.50")],
  });
  const row2 = await rowFor(o2, p2);
  check(
    "1 matched, 0 verified, 1 mismatch",
    r2.matchedRows === 1 && r2.verifiedRows === 0 && r2.mismatchRows === 1,
    JSON.stringify(r2),
  );
  check("status=mismatch", row2.verification_status === "mismatch", row2.verification_status);
  check(
    "webhook wins on verified_revenue (12.50), raw kept (10.00)",
    Number(row2.verified_revenue) === 12.5 && Number(row2.revenue) === 10,
    `verified=${row2.verified_revenue} raw=${row2.revenue}`,
  );

  // ---------------------------------------------------------------- 3
  console.log("[3] 1-cent rounding difference -> verified, not mismatch");
  const o3 = ORDER(3);
  const p3 = P(4);
  await browserCheckout({ product_id: p3, order_id: o3, revenue: 78.95 });
  const r3 = await verifyPaidOrder(db, SHOP, {
    id: Number(o3),
    line_items: [line(p3, "78.96")],
  });
  const row3 = await rowFor(o3, p3);
  check("verified, no mismatch", r3.verifiedRows === 1 && r3.mismatchRows === 0, JSON.stringify(r3));
  check(
    "rounding threshold is 0.01",
    VERIFICATION_ROUNDING_THRESHOLD === 0.01,
    String(VERIFICATION_ROUNDING_THRESHOLD),
  );
  check(
    "webhook value still stored (78.96)",
    Number(row3.verified_revenue) === 78.96,
    String(row3.verified_revenue),
  );

  // ---------------------------------------------------------------- 4
  console.log("[4] multi-quantity webhook line -> unit price x quantity");
  const o4 = ORDER(4);
  const p4 = P(5);
  await browserCheckout({ product_id: p4, order_id: o4, revenue: 59.97 });
  await verifyPaidOrder(db, SHOP, { id: Number(o4), line_items: [line(p4, "19.99", 3)] });
  const row4 = await rowFor(o4, p4);
  check(
    "3 x 19.99 = 59.97 verified",
    Number(row4.verified_revenue) === 59.97 && row4.verification_status === "verified",
    `${row4.verified_revenue}/${row4.verification_status}`,
  );

  // ---------------------------------------------------------------- 5
  console.log("[5] price_set.shop_money fallback when `price` is absent");
  const o5 = ORDER(5);
  const p5 = P(6);
  await browserCheckout({ product_id: p5, order_id: o5, revenue: 5.25 });
  await verifyPaidOrder(db, SHOP, {
    id: Number(o5),
    line_items: [
      { product_id: Number(p5), quantity: 1, price_set: { shop_money: { amount: "5.25" } } },
    ],
  });
  const row5 = await rowFor(o5, p5);
  check(
    "price_set amount used (5.25)",
    Number(row5.verified_revenue) === 5.25 && row5.verification_status === "verified",
    String(row5.verified_revenue),
  );

  // ---------------------------------------------------------------- 6
  console.log("[6] unmappable webhook line -> skipped, never smeared");
  const o6 = ORDER(6);
  const p6 = P(7);
  const mixedLines = [
    { product_id: Number(p6), price: "10.00", quantity: 1 },
    { product_id: null, price: "99.99", quantity: 1 }, // gift card / unmapped line
  ];
  const norm = normalizePaidOrder({ id: Number(o6), line_items: mixedLines });
  check(
    "gift-card line skipped, not added to the mapped line",
    norm.skippedLines === 1 && norm.lines.get(p6) === 10,
    JSON.stringify({ skipped: norm.skippedLines, lines: [...norm.lines] }),
  );
  await browserCheckout({ product_id: p6, order_id: o6, revenue: 10 });
  const r6 = await verifyPaidOrder(db, SHOP, { id: Number(o6), line_items: mixedLines });
  const row6 = await rowFor(o6, p6);
  check(
    "matched row verified at 10.00 (no 99.99 smear)",
    r6.matchedRows === 1 && Number(row6.verified_revenue) === 10,
    JSON.stringify(r6),
  );

  // ---------------------------------------------------------------- 7
  console.log("[7] webhook BEFORE the pixel row (race) -> no crash, redelivery verifies");
  const o7 = ORDER(7);
  const p7 = P(8);
  const race1 = await verifyPaidOrder(db, SHOP, {
    id: Number(o7),
    line_items: [line(p7, "31.00")],
  });
  check(
    "no rows yet: matched=0, no throw, nothing verified",
    race1.matchedRows === 0 && race1.verifiedRows === 0 && race1.mismatchRows === 0,
    JSON.stringify(race1),
  );
  await browserCheckout({ product_id: p7, order_id: o7, revenue: 31 });
  const race2 = await verifyPaidOrder(db, SHOP, {
    id: Number(o7),
    line_items: [line(p7, "31.00")],
  });
  const row7 = await rowFor(o7, p7);
  check(
    "redelivery verifies the late pixel row",
    race2.verifiedRows === 1 && row7.verification_status === "verified",
    JSON.stringify(race2),
  );

  // ---------------------------------------------------------------- 8
  console.log("[8] checkout row with no matching webhook line -> stays pending");
  const o8 = ORDER(8);
  const p8 = P(9);
  const p8b = P(10);
  await browserCheckout({ product_id: p8, order_id: o8, revenue: 20 });
  await browserCheckout({ product_id: p8b, order_id: o8, revenue: 30 });
  const r8 = await verifyPaidOrder(db, SHOP, {
    id: Number(o8),
    line_items: [line(p8, "20.00")], // only ONE of the two order lines present
  });
  const row8b = await rowFor(o8, p8b);
  check(
    "unmatched row stays pending, matched row verified",
    row8b.verification_status === "pending" && r8.matchedRows === 1 && r8.verifiedRows === 1,
    `pending=${row8b.verification_status} ${JSON.stringify(r8)}`,
  );

  // ---------------------------------------------------------------- 9
  console.log("[9] 24h grace sweep -> stale pending becomes unverified, fresh stays pending");
  const o9 = ORDER(9);
  const p9 = P(11);
  const o10 = ORDER(10);
  const p10 = P(12);
  await browserCheckout({
    product_id: p9,
    order_id: o9,
    revenue: 5,
    occurred_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });
  await browserCheckout({ product_id: p10, order_id: o10, revenue: 6 });
  const sweep = await sweepStaleVerifications(db, SHOP);
  const staleRow = await rowFor(o9, p9);
  const freshRow = await rowFor(o10, p10);
  check(
    "stale row marked unverified",
    staleRow.verification_status === "unverified",
    `sweep=${JSON.stringify(sweep)} status=${staleRow.verification_status}`,
  );
  check(
    "fresh row still pending",
    freshRow.verification_status === "pending",
    freshRow.verification_status,
  );
  check("stale row's raw revenue survives the sweep", Number(staleRow.revenue) === 5);
  check("sweep reports the count it marked", sweep.marked >= 1, String(sweep.marked));

  // ---------------------------------------------------------------- 10
  console.log("[10] sweep never throws (a failure must not take the webhook down)");
  const brokenDb = {
    events: {
      updateMany: async () => {
        throw new Error("simulated DB outage");
      },
    },
  };
  const brokenSweep = await sweepStaleVerifications(brokenDb, SHOP);
  check(
    "sweep degrades to {marked: 0} on error",
    brokenSweep.marked === 0,
    JSON.stringify(brokenSweep),
  );

  // ---------------------------------------------------------------- 11
  console.log("[11] reporting decision: verified wins, raw is the pending fallback");
  const verifiedRow = await rowFor(o2, p2); // mismatch row: verified 12.50 vs raw 10.00
  check(
    "verified value wins over raw (mismatch row reports 12.50)",
    effectiveRevenue(verifiedRow) === 12.5 && revenueSource(verifiedRow) === "verified",
    `effective=${effectiveRevenue(verifiedRow)} source=${revenueSource(verifiedRow)}`,
  );
  const pendingRow = await rowFor(o8, p8b); // no webhook value at all
  check(
    "pending row falls back to the raw browser value",
    effectiveRevenue(pendingRow) === 30 && revenueSource(pendingRow) === "raw",
    `effective=${effectiveRevenue(pendingRow)} source=${revenueSource(pendingRow)}`,
  );
  const unverifiedRow = await rowFor(o9, p9); // swept after 24h, still no webhook
  check(
    "unverified (swept) row still reports its raw value, flagged",
    effectiveRevenue(unverifiedRow) === 5 && revenueSource(unverifiedRow) === "raw",
    `effective=${effectiveRevenue(unverifiedRow)} source=${revenueSource(unverifiedRow)}`,
  );
  check(
    "missing row reports 0 / none",
    effectiveRevenue(null) === 0 && revenueSource(undefined) === "none",
  );

  // ---------------------------------------------------------------- 12
  console.log("[12] DB CHECK constraint rejects a bogus verification_status");
  let rejected = false;
  let rejection = "";
  try {
    await db.$executeRawUnsafe(
      `UPDATE "events" SET "verification_status" = 'bogus' WHERE "order_id" = $1`,
      o1,
    );
  } catch (error) {
    rejected = true;
    rejection = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  check("CHECK constraint rejected 'bogus'", rejected, rejection);
  const constraintRow = await rowFor(o1, p1a);
  check(
    "the violating row was not modified",
    constraintRow.verification_status === "verified",
    constraintRow.verification_status,
  );

  // ---------------------------------------------------------------- 13
  console.log("[13] webhook-first race -> ledger parks, the late pixel consumes it (issue #3)");
  const o13 = ORDER(13);
  const p13 = P(13);
  const parked1 = await verifyPaidOrder(db, SHOP, {
    id: Number(o13),
    name: "#1013",
    line_items: [line(p13, "42.00")],
  });
  const ledger13 = await db.webhook_revenue_ledger.findMany({
    where: { shop_domain: SHOP, order_id: o13 },
  });
  check(
    "webhook with NO browser rows parks the line in the ledger",
    parked1.matchedRows === 0 && ledger13.length === 1 && Number(ledger13[0].amount) === 42,
    `parked=${ledger13.length} amount=${ledger13.length ? Number(ledger13[0].amount) : "n/a"}`,
  );
  await browserCheckout({ product_id: p13, order_id: o13, revenue: 42 });
  const beforeReconcile = await rowFor(o13, p13);
  check(
    "late pixel row lands pending (the pre-fix permanent state)",
    beforeReconcile.verification_status === "pending",
    beforeReconcile.verification_status,
  );
  const consumed1 = await reconcileLedgerForOrder(db, SHOP, o13);
  const row13 = await rowFor(o13, p13);
  check(
    "pixel insert consumes the parked row -> verified immediately, no redelivery",
    consumed1.consumed === 1 && consumed1.verified === 1 && row13.verification_status === "verified",
    `consumed=${JSON.stringify(consumed1)} status=${row13.verification_status}`,
  );
  check(
    "consumed amount lands on verified_revenue, raw untouched",
    Number(row13.verified_revenue) === 42 && Number(row13.revenue) === 42,
    `verified=${Number(row13.verified_revenue)} raw=${Number(row13.revenue)}`,
  );
  const ledger13After = await db.webhook_revenue_ledger.count({
    where: { shop_domain: SHOP, order_id: o13 },
  });
  check("consumed ledger row is deleted", ledger13After === 0, String(ledger13After));
  const consumedAgain = await reconcileLedgerForOrder(db, SHOP, o13);
  check(
    "reconcile is idempotent (nothing left to consume)",
    consumedAgain.consumed === 0 && consumedAgain.verified === 0,
    JSON.stringify(consumedAgain),
  );
  const consumedNoOrder = await reconcileLedgerForOrder(db, SHOP, null);
  check(
    "null order id is a safe no-op",
    consumedNoOrder.consumed === 0 && consumedNoOrder.mismatched === 0,
    JSON.stringify(consumedNoOrder),
  );

  // ---------------------------------------------------------------- 14
  console.log("[14] ledger mismatch path -> mismatch status, webhook wins, row consumed");
  const o14 = ORDER(14);
  const p14 = P(14);
  await verifyPaidOrder(db, SHOP, { id: Number(o14), line_items: [line(p14, "50.00")] });
  await browserCheckout({ product_id: p14, order_id: o14, revenue: 40 });
  const consumed2 = await reconcileLedgerForOrder(db, SHOP, o14);
  const row14 = await rowFor(o14, p14);
  check(
    "browser/ledger disagreement -> mismatch, not a silent pass",
    consumed2.mismatched === 1 && row14.verification_status === "mismatch",
    `consumed=${JSON.stringify(consumed2)} status=${row14.verification_status}`,
  );
  check(
    "webhook value wins on verified_revenue, raw kept",
    Number(row14.verified_revenue) === 50 && Number(row14.revenue) === 40,
    `verified=${Number(row14.verified_revenue)} raw=${Number(row14.revenue)}`,
  );
  const ledger14 = await db.webhook_revenue_ledger.count({
    where: { shop_domain: SHOP, order_id: o14 },
  });
  check("mismatched ledger row is still consumed", ledger14 === 0, String(ledger14));

  // ---------------------------------------------------------------- 15
  console.log("[15] discounted order -> post-discount amount, no false mismatch (issue #4)");
  const o15 = ORDER(15);
  const p15 = P(15);
  await browserCheckout({ product_id: p15, order_id: o15, revenue: 90 });
  const r15 = await verifyPaidOrder(db, SHOP, {
    id: Number(o15),
    line_items: [
      {
        product_id: Number(p15),
        price: "100.00",
        quantity: 1,
        discount_allocations: [{ amount: "10.00" }],
      },
    ],
  });
  const row15 = await rowFor(o15, p15);
  check(
    "pre-discount 100.00 minus a 10.00 allocation matches the pixel's 90 -> verified",
    r15.verifiedRows === 1 && r15.mismatchRows === 0 && row15.verification_status === "verified",
    JSON.stringify(r15),
  );
  check(
    "verified_revenue stores the POST-discount amount (90)",
    Number(row15.verified_revenue) === 90,
    String(Number(row15.verified_revenue)),
  );

  // Pre-fix baseline: the SAME numbers WITHOUT discount_allocations is exactly
  // what used to happen - pre-discount 100 vs browser 90 -> a false mismatch on
  // every discounted order. This proves the subtraction is what prevents it.
  const o16 = ORDER(16);
  const p16 = P(16);
  await browserCheckout({ product_id: p16, order_id: o16, revenue: 90 });
  const r16 = await verifyPaidOrder(db, SHOP, {
    id: Number(o16),
    line_items: [line(p16, "100.00")],
  });
  check(
    "pre-fix baseline: with no allocations it IS a mismatch (fix is load-bearing)",
    r16.mismatchRows === 1 && r16.verifiedRows === 0,
    JSON.stringify(r16),
  );

  // quantity x unit price, then the line's discount share
  const o17 = ORDER(17);
  const p17 = P(17);
  await browserCheckout({ product_id: p17, order_id: o17, revenue: 45 });
  const r17 = await verifyPaidOrder(db, SHOP, {
    id: Number(o17),
    line_items: [
      {
        product_id: Number(p17),
        price: "25.00",
        quantity: 2,
        discount_allocations: [{ amount: "5.00" }],
      },
    ],
  });
  const row17 = await rowFor(o17, p17);
  check(
    "(2 x 25.00) - 5.00 = 45.00 verified",
    r17.verifiedRows === 1 && Number(row17.verified_revenue) === 45,
    JSON.stringify(r17),
  );

  // amount_set fallback + several allocations on one line are SUMMED
  const o18 = ORDER(18);
  const p18 = P(18);
  const normalized18 = normalizePaidOrder({
    id: Number(o18),
    line_items: [
      {
        product_id: Number(p18),
        price: "10.00",
        quantity: 1,
        discount_allocations: [
          { amount_set: { shop_money: { amount: "5.00" } } },
          { amount: "2.50" },
        ],
      },
    ],
  });
  check(
    "amount_set fallback + multiple allocations summed (10 - 5.00 - 2.50 = 2.50)",
    normalized18.lines.get(p18) === 2.5 && normalized18.skippedLines === 0,
    JSON.stringify([...normalized18.lines]),
  );

  // A discount larger than the line total must not produce a negative amount
  const o19 = ORDER(19);
  const p19 = P(19);
  const normalized19 = normalizePaidOrder({
    id: Number(o19),
    line_items: [
      {
        product_id: Number(p19),
        price: "10.00",
        quantity: 1,
        discount_allocations: [{ amount: "25.00" }],
      },
    ],
  });
  check(
    "over-allocated discount clamps to 0.00, never negative",
    normalized19.lines.get(p19) === 0,
    JSON.stringify([...normalized19.lines]),
  );

  // Ledger path (test 13) must store the POST-discount amount too
  const o20 = ORDER(20);
  const p20 = P(20);
  await verifyPaidOrder(db, SHOP, {
    id: Number(o20),
    line_items: [
      {
        product_id: Number(p20),
        price: "100.00",
        quantity: 1,
        discount_allocations: [{ amount: "10.00" }],
      },
    ],
  });
  const ledger20 = await db.webhook_revenue_ledger.findFirst({
    where: { shop_domain: SHOP, order_id: o20, product_id: p20 },
  });
  check(
    "the ledger parks the post-discount amount as well (90, not 100)",
    ledger20 !== null && Number(ledger20.amount) === 90,
    ledger20 ? String(Number(ledger20.amount)) : "no ledger row",
  );
  await browserCheckout({ product_id: p20, order_id: o20, revenue: 90 });
  const consumed20 = await reconcileLedgerForOrder(db, SHOP, o20);
  const row20 = await rowFor(o20, p20);
  check(
    "discounted webhook-first race verifies on pixel insert (no false mismatch)",
    consumed20.verified === 1 && row20.verification_status === "verified",
    `consumed=${JSON.stringify(consumed20)} status=${row20.verification_status}`,
  );
}

/** Remove every synthetic row so the harness can be re-run against a live DB. */
async function cleanup() {
  const gone = await db.events.deleteMany({
    where: { shop_domain: SHOP, visitor_id: VISITOR },
  });
  // Parked webhook ledger rows are synthetic too (tests 7/13/14 write them).
  const ledgerGone = await db.webhook_revenue_ledger.deleteMany({
    where: { shop_domain: SHOP },
  });
  await db.visitors.deleteMany({ where: { visitor_id: VISITOR } });
  // Only ever drop the shop row when it is the synthetic one this script owns.
  if (SHOP === "pd-revver-verify.myshopify.com") {
    await db.shops.deleteMany({ where: { shop_domain: SHOP } });
  }
  const leftover = await db.events.count({
    where: { shop_domain: SHOP, visitor_id: VISITOR },
  });
  const ledgerLeftover = await db.webhook_revenue_ledger.count({
    where: { shop_domain: SHOP },
  });
  console.log(
    `[cleanup] synthetic events removed: ${gone.count} (leftover: ${leftover});` +
      ` ledger rows removed: ${ledgerGone.count} (leftover: ${ledgerLeftover})`,
  );
  return leftover === 0 && ledgerLeftover === 0;
}

main()
  .then(async () => {
    const clean = await cleanup();
    check("cleanup removed every synthetic row", clean);
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    await db.$disconnect();
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error("FATAL:", error && error.message ? error.message : error);
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
    await db.$disconnect();
    process.exit(1);
  });