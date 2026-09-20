/**
 * #4 LIVE verification: discounted orders must NOT fire a false mismatch.
 *
 * Runs against the REAL dev store + REAL Admin API + REAL database:
 *   1. find a PAID order whose line items carry discount_allocations (if the
 *      store has none, create one: draft order with a 20% order-level discount,
 *      completed as paid — a real order on the dev store)
 *   2. build the orders/paid payload from the REAL REST order JSON (the exact
 *      shape the webhook delivers: per-line pre-discount unit `price`,
 *      `quantity`, `discount_allocations[].amount`)
 *   3. derive the post-discount per-line truth INDEPENDENTLY via GraphQL
 *      `discountedTotalSet.shopMoney.amount` (never via the fix's own
 *      subtraction — that would be circular) and seed the checkout_completed
 *      browser rows with it, exactly as the pixel would have reported
 *   4. run the SHIPPED verifyPaidOrder():
 *        -> verified, verified_revenue = post-discount total, no mismatch
 *   5. negative control: the SAME payload with discount_allocations stripped
 *      (the pre-fix behavior) MUST fire the mismatch -> proves the
 *      subtraction is what prevents the false mismatch
 *   6. restore: re-verify with the real payload so the row ends verified
 *
 * Cleanup removes only the synthetic browser rows/visitor it created; the real
 * order is left untouched.
 *
 * Usage: node scripts/verify-discount-mismatch-live.mjs   (reads .env)
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { normalizePaidOrder, verifyPaidOrder } from "../app/utils/order-verification.server.ts";

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
function die(msg) {
  console.error("FATAL: " + msg);
  process.exit(1);
}
const r2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------- token / client
const rows = await prisma.$queryRaw`SELECT shop, "accessToken", "refreshToken" FROM shopify_sessions LIMIT 1`;
if (!rows.length) die("no shopify_sessions row");
const shop = rows[0].shop;
console.log("=== #4 LIVE discount-mismatch verification ===");
console.log("shop: " + shop + " (api " + API_VERSION + ")");
async function works(token) {
  const res = await fetch("https://" + shop + "/admin/api/" + API_VERSION + "/graphql.json", {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ shop { name } }" }),
  });
  const body = await res.json().catch(() => ({}));
  return res.status === 200 && !body.errors;
}
let token = rows[0].accessToken;
if (!(await works(token))) {
  console.log("  stored token rejected; exchanging the refresh token...");
  const res = await fetch("https://" + shop + "/admin/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "refresh_token",
      refresh_token: rows[0].refreshToken,
    }),
  });
  if (!res.ok) die("token exchange failed: HTTP " + res.status);
  token = (await res.json()).access_token;
}
async function gql(query, variables = {}) {
  const res = await fetch("https://" + shop + "/admin/api/" + API_VERSION + "/graphql.json", {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) die("GraphQL errors: " + JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}
async function rest(path) {
  const res = await fetch("https://" + shop + "/admin/api/" + API_VERSION + "/" + path, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!res.ok) die("REST GET " + path + " failed: HTTP " + res.status);
  return res.json();
}
/** Sum of discount_allocations[].amount on one REST line item. */
function allocSum(line) {
  return (line.discount_allocations || []).reduce(
    (t, a) => t + Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0),
    0,
  );
}

/** Numeric product id from a REST line item. */
const pidOf = (li) => (Number.isInteger(li.product_id) && li.product_id > 0 ? li.product_id : 0);

// --------------------------------------------------- 1. find / create order
console.log("");
console.log("[1] locating a real discounted order (paid preferred; no paid one -> any status)");
const ORDERS_Q = `query($after: String) { orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: true) {
  edges { cursor node { id } } pageInfo { hasNextPage endCursor } } }`;
async function discountedPaidOrders() {
  const all = [];
  let after = null;
  for (;;) {
    const data = await gql(ORDERS_Q, { after });
    for (const e of data.orders.edges) {
      const id = String(e.node.id).match(/\/Order\/(\d+)$/)?.[1];
      const o = (await rest("orders/" + id + ".json")).order;
      if (o.financial_status !== "paid") continue;
      if (o.line_items.some((li) => pidOf(li) > 0 && allocSum(li) > 0)) all.push(o);
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  // Prefer paid orders (matches the orders/paid webhook exactly), but any
  // discounted order carries the real allocations the test needs.
  all.sort((a, b) => (b.financial_status === "paid") - (a.financial_status === "paid"));
  return all;
}
let candidates = await discountedPaidOrders();
let createdOrder = false;
if (!candidates.length) {
  console.log("  no discounted paid order exists; creating one (draft order + 20% order discount)...");
  const vq = await gql(`{ products(first: 10) { nodes { variants(first: 5) { nodes { id price } } } } }`);
  const variant = vq.products.nodes.flatMap((p) => p.variants.nodes).find((v) => Number(v.price) > 0);
  if (!variant) die("store has no variant with a positive price to order");
  const d1 = await gql(
    `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) {
       draftOrder { id } userErrors { field message } } }`,
    { input: {
        lineItems: [{ variantId: variant.id, quantity: 1 }],
        appliedDiscount: { description: "#4 live verification", valueType: "PERCENTAGE", value: 20 },
      } },
  );
  if (d1.draftOrderCreate.userErrors?.length) {
    die("draftOrderCreate userErrors: " + JSON.stringify(d1.draftOrderCreate.userErrors));
  }
  const d2 = await gql(
    `mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: false) {
       draftOrder { order { id } } userErrors { field message } } }`,
    { id: d1.draftOrderCreate.draftOrder.id },
  );
  if (d2.draftOrderComplete.userErrors?.length) {
    die("draftOrderComplete userErrors: " + JSON.stringify(d2.draftOrderComplete.userErrors));
  }
  createdOrder = true;
  candidates = await discountedPaidOrders();
}
if (!candidates.length) die("could not obtain a discounted paid order");
const order = candidates[0];
console.log(
  "  order " + order.name + " (id " + order.id + ", " + (createdOrder ? "newly created" : "existing") + ")" +
  " | lines: " + order.line_items.map((li) =>
    li.title + " price=" + li.price + " qty=" + li.quantity + " alloc=" + allocSum(li)).join("; "),
);

// --------------------------------------- 2. webhook payload + independent truth
console.log("");
console.log("[2] webhook payload (real REST order) vs independent GraphQL truth");
const payload = {
  id: order.id,
  name: order.name,
  line_items: order.line_items
    .filter((li) => pidOf(li) > 0)
    .map((li) => ({
      product_id: Number(li.product_id),
      price: li.price,
      quantity: li.quantity,
      discount_allocations: li.discount_allocations,
    })),
};
if (!payload.line_items.length) die("chosen order has no mappable numeric product lines");
const norm = normalizePaidOrder(payload);
// Per-line post-discount TRUTH from the REAL REST order JSON: unit price x
// quantity MINUS discount_allocations (raw Shopify data — the same field the
// webhook delivers; independent of the fix's own code path).
const truthByProduct = new Map();
for (const li of payload.line_items) {
  const alloc = (li.discount_allocations || []).reduce(
    (t, a) => t + Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0),
    0,
  );
  truthByProduct.set(
    String(li.product_id),
    r2((truthByProduct.get(li.product_id) ?? 0) + Math.max(0, Number(li.price) * li.quantity - alloc)),
  );
}
// INDEPENDENT cross-check at the ORDER level. NOTE: OrderLineItem's
// discountedTotalSet CANNOT be the truth for order-level discounts — Shopify
// does NOT allocate order-level discounts to line items there (it reported the
// PRE-discount 699.95 for this order). The order's final charge minus shipping
// minus tax does include them:
const oq = await gql(
  `query($id: ID!) { order(id: $id) {
     totalPriceSet { shopMoney { amount } }
     totalShippingPriceSet { shopMoney { amount } }
     totalTaxSet { shopMoney { amount } } } }`,
  { id: "gid://shopify/Order/" + order.id },
);
const orderTruth = r2(
  Number(oq.order.totalPriceSet.shopMoney.amount) -
  Number(oq.order.totalShippingPriceSet.shopMoney.amount) -
  Number(oq.order.totalTaxSet.shopMoney.amount),
);
const lineTruthSum = r2([...truthByProduct.values()].reduce((t, v) => t + v, 0));
check(
  "order-level GraphQL truth (totalPrice - shipping - tax) == sum of per-line post-discount truths",
  Math.abs(orderTruth - lineTruthSum) <= 0.011,
  "order=" + orderTruth + " lines=" + lineTruthSum,
);
for (const [pid, amount] of norm.lines) {
  check(
    "webhook post-discount amount == REST truth (price x qty - allocations)",
    Math.abs(amount - (truthByProduct.get(pid) ?? NaN)) <= 0.011,
    "product " + pid + ": webhook=" + amount + " truth=" + truthByProduct.get(pid),
  );
}



// ------------------------------------------------ 3. seed browser pixel rows
const VISITOR = randomUUID();
await prisma.visitors.upsert({
  where: { visitor_id: VISITOR },
  update: { shop_domain: shop },
  create: { visitor_id: VISITOR, shop_domain: shop },
});
const seeded = [];
for (const [pid, truth] of truthByProduct) {
  seeded.push(
    await prisma.events.create({
      data: {
        visitor_id: VISITOR,
        shop_domain: shop,
        event_type: "checkout_completed",
        product_id: String(pid),
        order_id: norm.orderId,
        revenue: truth, // what the pixel reports: the post-discount value
      },
    }),
  );
}
async function resetRows() {
  for (const s of seeded) {
    await prisma.events.update({
      where: { event_id: s.event_id },
      data: { verified_revenue: null, verification_status: "pending", verified_at: null },
    });
  }
}
const refreshRows = () => Promise.all(seeded.map((s) => prisma.events.findUnique({ where: { event_id: s.event_id } })));
try {
  console.log("");
  console.log("[3] SHIPPED verifyPaidOrder with the REAL webhook payload");
  const fixed = await verifyPaidOrder(prisma, shop, payload);
  check(
    "every discounted line matched and verified (no false mismatch)",
    fixed.matchedRows === seeded.length && fixed.verifiedRows === seeded.length && fixed.mismatchRows === 0,
    JSON.stringify(fixed),
  );
  const rowsFixed = await refreshRows();
  check(
    "verified_revenue equals the true post-discount amount",
    rowsFixed.every((r) => Math.abs(Number(r.verified_revenue) - truthByProduct.get(String(r.product_id))) <= 0.011),
    rowsFixed.map((r) => r.product_id + "=" + r.verified_revenue).join(", "),
  );
  check(
    "rows end in status=verified with verified_at set",
    rowsFixed.every((r) => r.verification_status === "verified" && r.verified_at !== null),
  );

  console.log("");
  console.log("[4] negative control: same REAL payload, discount_allocations stripped (pre-fix behavior)");
  await resetRows();
  const stripped = {
    id: payload.id,
    name: payload.name,
    line_items: payload.line_items.map(({ discount_allocations, ...rest }) => rest),
  };
  const preFix = await verifyPaidOrder(prisma, shop, stripped);
  const rowsPre = await refreshRows();
  check(
    "without the subtraction the false mismatch FIRES (proves the fix is the difference)",
    preFix.mismatchRows === seeded.length,
    JSON.stringify(preFix) + " | stored pre-discount=" + rowsPre.map((r) => r.verified_revenue).join(","),
  );

  console.log("");
  console.log("[5] restore: re-verify with the real payload");
  await resetRows();
  await verifyPaidOrder(prisma, shop, payload);
  const rowsEnd = await refreshRows();
  check(
    "row is verified again after the control",
    rowsEnd.every((r) => r.verification_status === "verified"),
  );
} finally {
  console.log("");
  console.log("[cleanup] removing synthetic browser rows + visitor (real order untouched)");
  for (const s of seeded) {
    await prisma.events.delete({ where: { event_id: s.event_id } }).catch(() => {});
  }
  await prisma.visitors.delete({ where: { visitor_id: VISITOR } }).catch(() => {});
  await prisma.webhook_revenue_ledger
    .deleteMany({ where: { shop_domain: shop, order_id: norm.orderId } })
    .catch(() => {});
}

console.log("");
console.log(
  fail === 0
    ? "RESULT: " + pass + " passed, 0 failed - discounted order verified at the true post-discount revenue, no false mismatch"
    : "RESULT: " + pass + " passed, " + fail + " FAILED",
);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);

