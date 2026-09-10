// temp — idempotency proof: POST the same checkout_completed payload twice to the
// live /api/events endpoint and verify it only persists once.
//
// Uses the same app-URL resolution as smoke-test-pixel.mjs (SHOPIFY_APP_URL env,
// else the dev-bundle manifest's app_home.app_url). Needs `npm run dev` running.
import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.loadEnvFile(".env");
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

const SHOP = "pd-test-ubhzd2gl.myshopify.com";

function resolveAppUrl() {
  const fromEnv = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), ".shopify", "dev-bundle", "manifest.json"), "utf8"),
    );
    const appHome = (manifest.modules ?? []).find(
      (mod) => mod.type === "app_home" && mod.config?.app_url,
    );
    if (appHome?.config?.app_url) return appHome.config.app_url.replace(/\/+$/, "");
  } catch {
    /* fall through */
  }
  return "";
}

(async () => {
  const appUrl = resolveAppUrl();
  if (!appUrl) {
    console.error("[idem] FAIL: could not resolve app URL — is `npm run dev` running?");
    process.exit(2);
  }
  const apiUrl = `${appUrl}/api/events`;
  console.log("[idem] api:", apiUrl);

  // Fresh throwaway visitor so this run cannot collide with real data.
  const visitorId = randomUUID();
  const orderId = `idem-test-${Date.now()}`;
  const payload = {
    event_type: "checkout_completed",
    visitor_id: visitorId,
    shop_domain: SHOP,
    order_id: orderId,
    revenue: "123.45",
    occurred_at: new Date().toISOString(),
    // One checkout, two line items — the idempotency grain is per-product.
    line_items: [
      { product_id: "9999000000001", revenue: "78.95" },
      { product_id: "9999000000002", revenue: "44.50" },
    ],
  };

  const before = await prisma.events.count({
    where: { shop_domain: SHOP, order_id: orderId },
  });
  const beforeRevenue = await prisma.events.aggregate({
    where: { shop_domain: SHOP, order_id: orderId },
    _sum: { revenue: true },
  });
  console.log(`BEFORE: rows=${before} revenue_sum=${beforeRevenue._sum.revenue ?? 0}`);

  // POST twice, identical body.
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`POST #${i} -> HTTP ${res.status} body=${text.trim().slice(0, 120)}`);
  }

  // Give async persistence a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const after = await prisma.events.count({
    where: { shop_domain: SHOP, order_id: orderId },
  });
  const afterRevenue = await prisma.events.aggregate({
    where: { shop_domain: SHOP, order_id: orderId },
    _sum: { revenue: true },
  });
  console.log(`AFTER: rows=${after} revenue_sum=${afterRevenue._sum.revenue ?? 0}`);

  const rows = await prisma.events.findMany({
    where: { shop_domain: SHOP, order_id: orderId },
    select: { product_id: true, revenue: true, event_id: true },
    orderBy: { product_id: "asc" },
  });
  console.log("rows:");
  for (const r of rows) console.log(`  ${r.product_id} revenue=${r.revenue} (${r.event_id})`);

  const rowsDelta = after - before;
  const expectedRows = payload.line_items.length;
  const revenueOk =
    rows.length === expectedRows &&
    after === before + expectedRows &&
    rows.every((r) => r.product_id);

  console.log(`\nrowsDelta=${rowsDelta} (expected ${expectedRows})`);
  console.log(`revenue_sum=${afterRevenue._sum.revenue ?? 0}`);

  const pass = rowsDelta === expectedRows && revenueOk;
  console.log(pass ? "RESULT: PASS ✅ (duplicate ignored, no double revenue)" : "RESULT: FAIL ❌");
  await prisma.$disconnect();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => {
  console.error("[idem] fatal:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});