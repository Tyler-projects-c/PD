/**
 * Canonical product-ID verification for product_impressions (handle fallback bug).
 *
 * Runs a pd-treatment.js file in headless Chromium against a fixed fixture page
 * (served via route interception, no network) that mirrors the problematic theme
 * shape: product cards with NO data-product-id anywhere.
 *
 * Asserts (the fix's contract):
 *   1. A card WITHOUT a theme-provided data-product-id gets data-pd-product-id set
 *      to the CANONICAL NUMERIC id resolved from the storefront products.json map —
 *      never the handle string.
 *   2. Published pd:product_impressions product_ids are 100% numeric.
 *   3. A handle missing from the map is SKIPPED with a loud console warn
 *      ("unresolvable"), and never published as an id.
 *   4. Exactly ONE products.json fetch per page regardless of card count (batched).
 *
 * Usage:
 *   node scripts/verify-canonical-impressions.mjs [path-to-pd-treatment.js]
 *
 * Run it twice to see before/after: once with the working copy, once with e.g.
 * the HEAD version extracted via `git show HEAD:... > tmp.js`.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

const fileUnderTest =
  process.argv[2] || path.join("extensions", "pd-treatment", "assets", "pd-treatment.js");
const treatmentSrc = readFileSync(fileUnderTest, "utf8");

const FIXTURE_ORIGIN = "https://pd-fixture.test";
const PAGE_URL = FIXTURE_ORIGIN + "/collections/all";

// handle -> canonical numeric id, as the storefront products.json would return.
const STORE_MAP = {
  beta: "2222222222222",
  delta: "4444444444444",
};
// ghost-handle intentionally MISSING -> must be skipped with a warn, never published.

const FIXTURE_HTML = `<!doctype html>
<html><head><title>fixture</title></head>
<body>
  <ul class="grid product-grid">
    <li class="grid__item" id="card-a" data-product-id="1111111111111">
      <a href="/products/alpha">Alpha (theme exposes numeric id)</a>
    </li>
    <li class="grid__item" id="card-b">
      <a href="/products/beta">Beta (NO id in markup - the bug case)</a>
    </li>
    <li class="grid__item" id="card-c">
      <a href="/products/ghost-handle">Ghost (not in storefront map)</a>
    </li>
    <li class="grid__item" id="card-d">
      <span data-product-id="3333333333333"></span>
      <a href="/products/delta">Delta (nested numeric id)</a>
    </li>
  </ul>
  <script>
    window.__pdPublishes = [];
    window.Shopify = {
      shop: "pd-fixture.myshopify.com",
      analytics: {
        publish: function (event, data) {
          window.__pdPublishes.push({ event: event, data: data });
        },
      },
    };
  </script>
  <script>${treatmentSrc.replace(/<\/script>/g, "<\\/script>")}</script>
</body></html>`;

let productsJsonHits = 0;

async function main() {
  const consoleMessages = [];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => consoleMessages.push(msg.text()));

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === PAGE_URL || url.startsWith(PAGE_URL + "?")) {
      await route.fulfill({ contentType: "text/html", body: FIXTURE_HTML });
    } else if (url.startsWith(FIXTURE_ORIGIN + "/collections/all/products.json")) {
      productsJsonHits++;
      const body = JSON.stringify({
        products: Object.entries(STORE_MAP).map(([handle, id]) => ({ id: Number(id), handle })),
      });
      await route.fulfill({ contentType: "application/json", body });
    } else {
      await route.abort(); // assign() etc. — errors are caught by the script
    }
  });

  await page.goto(PAGE_URL, { waitUntil: "load" });

  // Dwell is 400ms, publish debounce 800ms — poll until the impression batch lands.
  await page.waitForFunction(
    () => window.__pdPublishes.some((p) => p.event === "pd:product_impressions"),
    null,
    { timeout: 8000 }
  );

  // Capture everything we need BEFORE closing the browser.
  const snapshot = await page.evaluate(() => ({
    publishes: window.__pdPublishes,
    cardAttrs: {
      a: document.getElementById("card-a")?.getAttribute("data-pd-product-id"),
      b: document.getElementById("card-b")?.getAttribute("data-pd-product-id"),
      c: document.getElementById("card-c")?.getAttribute("data-pd-product-id"),
      d: document.getElementById("card-d")?.getAttribute("data-pd-product-id"),
    },
  }));
  await browser.close();

  const publishedIds = snapshot.publishes
    .filter((p) => p.event === "pd:product_impressions")
    .flatMap((p) => (p.data && p.data.product_ids) || []);
  const numeric = (id) => /^\d+$/.test(String(id));

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass, detail });

  check(
    "all published product_ids are numeric",
    publishedIds.length > 0 && publishedIds.every(numeric),
    publishedIds.join(", ") || "(none)"
  );
  check(
    "bug-case card tagged with canonical numeric id (card-b -> 2222222222222, not 'beta')",
    snapshot.cardAttrs.b === STORE_MAP.beta,
    "card-b data-pd-product-id=" + snapshot.cardAttrs.b
  );
  check(
    "no handle string ever tagged or published",
    Object.values(snapshot.cardAttrs).every((v) => v === null || numeric(v)) &&
      publishedIds.every(numeric),
    "attrs=[" + JSON.stringify(snapshot.cardAttrs) + "] ids=[" + publishedIds.join(",") + "]"
  );
  check(
    "unresolvable handle skipped with loud warn (ghost-handle)",
    consoleMessages.some((m) => m.includes("unresolvable") && m.includes("ghost-handle")),
    consoleMessages.filter((m) => m.includes("ghost-handle")).join(" | ").slice(0, 120) ||
      "(no warn seen)"
  );
  check(
    "batched: exactly ONE products.json fetch for the unresolved cards",
    productsJsonHits === 1,
    String(productsJsonHits)
  );

  const passed = checks.every((c) => c.pass);
  console.log("=== canonical-impressions verification [" + path.basename(fileUnderTest) + "] ===");
  for (const c of checks) {
    console.log((c.pass ? "PASS" : "FAIL") + "  " + c.name + "  (" + c.detail + ")");
  }
  console.log("published product_ids: [" + publishedIds.join(", ") + "]");
  console.log("card attrs: " + JSON.stringify(snapshot.cardAttrs));
  console.log("RESULT: " + (passed ? "PASS" : "FAIL"));
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error("verify-canonical-impressions crashed:", error);
  process.exitCode = 1;
});
