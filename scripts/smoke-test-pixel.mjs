#!/usr/bin/env node
/**
 * scripts/smoke-test-pixel.mjs - repeatable local E2E smoke test for the PD
 * storefront -> web pixel -> /api/events -> Postgres pipeline.
 *
 * Prerequisites (already done by hand, per the workflow):
 *   - `npm run dev` is running (fresh Cloudflare tunnel URL in .env)
 *   - The app was installed on the store once via OAuth (shops row exists)
 *
 * One-time setup:
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Usage (from repo root):
 *   node --env-file=.env scripts/smoke-test-pixel.mjs            # headless
 *   node --env-file=.env scripts/smoke-test-pixel.mjs --headed   # watch it
 *
 * Storefront password (only needed while the store is behind a password page):
 *   set PD_STORE_PASSWORD=<password> in .env (same file this script reads via
 *   --env-file) so it persists across terminal sessions. A shell env var also
 *   works and takes precedence over .env when both are set.
 *
 * Env overrides:
 *   PD_STORE_PASSWORD  storefront password (from .env or a shell env var)
 *   PD_STORE_SHOP      store domain (default pd-test-ubhzd2gl.myshopify.com)
 *   PD_SEARCH_TERM     search term typed into the storefront search (default snowboard)
 *   PD_WAIT_MS         settle time for fire-and-forget POSTs (default 6000)
 *   PD_HEADED=1        same as --headed
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = prerequisite problem
 */

import process from "node:process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// Load .env if the script is run without --env-file=.env (never overrides
// already-set vars such as PD_STORE_PASSWORD).
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env");
  }
} catch {
  /* .env is optional here; the documented invocation uses --env-file=.env */
}

const args = process.argv.slice(2);
const HEADED = args.includes("--headed") || process.env.PD_HEADED === "1";
const SHOP = (process.env.PD_STORE_SHOP ?? "pd-test-ubhzd2gl.myshopify.com")
  .replace(/\/+$/, "")
  .trim();
const STORE_BASE = `https://${SHOP}`;
const SEARCH_TERM = process.env.PD_SEARCH_TERM || "snowboard";
const SETTLE_MS = Number(process.env.PD_WAIT_MS ?? 6000);
const NAV_TIMEOUT = 30_000;
const SHOT_DIR = "scripts/.smoke";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "[smoke] Playwright is not installed. Run:\n" +
      "  npm i -D playwright\n  npx playwright install chromium",
  );
  process.exit(2);
}

const prisma = new PrismaClient();
const warnings = [];

function log(...a) {
  console.log("[smoke]", ...a);
}
function warn(...a) {
  console.warn("[smoke] WARN:", ...a);
  warnings.push(a.join(" "));
}

// ---- DB helpers ----------------------------------------------------------

async function dbCounts(shop) {
  const [events, visitors, shops] = await Promise.all([
    prisma.events.count({ where: { shop_domain: shop } }),
    prisma.visitors.count({ where: { shop_domain: shop } }),
    prisma.shops.count({ where: { shop_domain: shop } }),
  ]);
  return { events, visitors, shops };
}

// ---- Shopify Admin API (read-only + one apiUrl resync; token from DB) ----

async function adminGraphql(query, variables, accessToken) {
  const r = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (body.errors) {
    // Shopify returns errors as an array on GraphQL errors but as a plain
    // string/object on auth failures (e.g. an expired session token).
    const msgs = Array.isArray(body.errors)
      ? body.errors.map((e) => e.message)
      : [typeof body.errors === "string" ? body.errors : JSON.stringify(body.errors)];
    const err = new Error(msgs.join("; "));
    err.status = r.status;
    throw err;
  }
  return body;
}

function extractApiUrl(settings) {
  if (!settings) return null;
  try {
    return JSON.parse(settings)?.apiUrl ?? null;
  } catch {
    const m = String(settings).match(/"apiUrl"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }
}

// Resolve the app's public URL, in order of preference:
//   1. process.env.SHOPIFY_APP_URL (set from .env via --env-file, or a real
//      shell export).
//   2. The current dev session's tunnel URL from the CLI's dev-bundle
//      manifest. The Shopify CLI injects the live tunnel URL into the dev
//      server's process env (HOST -> SHOPIFY_APP_URL in vite.config.ts) but
//      does NOT persist it to .env, so a standalone process cannot see it
//      there. The CLI does write it into .shopify/dev-bundle/manifest.json
//      (app_home.config.app_url) on every `npm run dev`.
function resolveAppUrl() {
  const fromEnv = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), ".shopify", "dev-bundle", "manifest.json"),
        "utf8",
      ),
    );
    const appHome = (manifest.modules ?? []).find(
      (mod) => mod.type === "app_home" && mod.config?.app_url,
    );
    if (appHome?.config?.app_url) return appHome.config.app_url.replace(/\/+$/, "");
  } catch {
    /* manifest missing/unreadable - fall through */
  }
  return "";
}

async function preflight() {
  log("--- pre-flight ---");
  const appUrl = resolveAppUrl();
  if (!appUrl) {
    console.error(
      "[smoke] FAIL: could not determine the app URL.\n" +
        "  SHOPIFY_APP_URL is empty and .shopify/dev-bundle/manifest.json does not " +
        "contain a tunnel URL.\n" +
        "  Make sure `npm run dev` is running (it writes the manifest), then re-run.",
    );
    process.exit(2);
  }
  const apiUrl = `${appUrl}/api/events`;

  // 1) Tunnel + app reachability. Our route answers GET with 405; a dead
  //    Cloudflare tunnel answers 530 (origin unreachable at the edge).
  try {
    const r = await fetch(apiUrl, { method: "GET" });
    if (r.status === 405) {
      log(`app endpoint reachable: ${apiUrl} -> HTTP ${r.status} (405 expected)`);
    } else {
      console.error(
        `[smoke] FAIL: ${apiUrl} responded HTTP ${r.status} (expected 405).\n` +
          (r.status === 530
            ? "  The current `npm run dev` tunnel is registered but not serving the app " +
              "(stale/hung Cloudflare tunnel). Restart it: Ctrl+C in the dev terminal, " +
              "run `npm run dev` again, then re-run this test."
            : "  The app responded unexpectedly. Verify `npm run dev` is healthy, then re-run."),
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(
      `[smoke] FAIL: cannot reach ${apiUrl} (${e.cause?.code ?? e.message}). ` +
        "Is `npm run dev` actually running? Restart it and re-run.",
    );
    process.exit(2);
  }

  // 2) Shops row invariant (a shops row exists = the OAuth install ran).
  const shopCount = await prisma.shops.count({ where: { shop_domain: SHOP } });
  if (shopCount === 0) {
    warn(
      `no shops row for ${SHOP}. Run the OAuth install once ` +
        `(open ${appUrl}/auth?shop=${SHOP}) so events can pass the FK constraint.`,
    );
  } else {
    log(`shops row present for ${SHOP}: OK`);
  }

  // 3) Pixel existence + apiUrl resync (optional, but silences the stale-tunnel
  //    trap so this test stays a single command).
  const session = await prisma.shopify_sessions.findFirst({
    where: { shop: SHOP },
    select: { accessToken: true },
  });
  if (!session?.accessToken) {
    warn("no session token in DB - run the OAuth install flow first.");
    return apiUrl;
  }
  let pixel = null;
  try {
    const res = await adminGraphql(
      "query { webPixel { id settings } }",
      undefined,
      session.accessToken,
    );
    pixel = res.data?.webPixel ?? null;
  } catch (e) {
    if (String(e.message).includes("No web pixel was found for this app")) {
      warn("web pixel is not registered. Click \"Enable tracking\" on the app home once (one-time manual step).");
    } else {
      warn(
        `could not verify pixel via Admin API (${e.message}${e.status ? `, HTTP ${e.status}` : ""}). ` +
          "If the session token is stale, load the app home once in a browser to re-auth, then re-run.",
      );
    }
    return apiUrl;
  }
  if (!pixel) {
    return apiUrl;
  }
  log(`pixel id: ${pixel.id}`);
  const currentApiUrl = extractApiUrl(pixel.settings);
  log(`stored apiUrl: ${currentApiUrl}`);
  if (currentApiUrl !== apiUrl) {
    try {
      await adminGraphql(
        `mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
          webPixelUpdate(id: $id, webPixel: $webPixel) { userErrors { message } }
        }`,
        { id: pixel.id, webPixel: { settings: { apiUrl } } },
        session.accessToken,
      );
      log(`resynced pixel apiUrl -> ${apiUrl}`);
    } catch (e) {
      warn(`could not resync pixel apiUrl (${e.message}); events may POST to a stale URL.`);
    }
  } else {
    log("pixel apiUrl is current: OK");
  }
  return apiUrl;
}

// ---- Browser actions -------------------------------------------------------

const pixelLogs = [];
let requestCount = 0;

function wirePixelCapture(worker) {
  worker.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("PD pixel:")) {
      pixelLogs.push(text);
      log(`[pixel-worker] ${text}`);
    }
  });
}

async function dismissPasswordPage(page) {
  // Shopify's storefront password page: input[name="password"] + form button.
  const pwInput = page.locator('input[name="password"]');
  if ((await pwInput.count()) === 0) return false;
  const password = process.env.PD_STORE_PASSWORD;
  if (!password) {
    console.error(
      "[smoke] FAIL: the storefront password page is showing but PD_STORE_PASSWORD " +
        "is not set. Add PD_STORE_PASSWORD=<password> to .env and re-run " +
        "(a shell env var also works, but .env persists across sessions).",
    );
    await page.context().close();
    process.exit(2);
  }
  log("password page detected - unlocking storefront…");
  await pwInput.fill(password);
  await pwInput.press("Enter");
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT });
  return true;
}

async function goto(page, path, label) {
  await page.goto(`${STORE_BASE}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await dismissPasswordPage(page);
  // Give the pixel worker a moment to subscribe + fire on this page.
  await page.waitForTimeout(1500);
  log(`visited: ${label} (${path})`);
}

async function main() {
  const baseline = await dbCounts(SHOP);
  if (baseline.shops === 0) {
    console.error(
      "[smoke] FAIL: no shops row for " + SHOP +
        ". Run the OAuth install once first (open $SHOPIFY_APP_URL/auth?shop=" + SHOP +
        " while `npm run dev` is running).",
    );
    await prisma.$disconnect();
    process.exit(2);
  }
  log(`baseline (shop=${SHOP}): events=${baseline.events} visitors=${baseline.visitors}`);

  const apiUrl = await preflight();

  log(`--- browser (${HEADED ? "headed" : "headless"}) ---`);
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Pixel visibility: web pixels run in a dedicated worker (strict sandbox) -
  // attach to every worker this page spawns and mirror matching console lines.
  page.on("worker", (worker) => {
    log(`worker attached: ${worker.url().slice(0, 90)}`);
    wirePixelCapture(worker);
  });

  // Count outbound POSTs to the ingestion endpoint (visible even if the worker
  // console mirroring misses, since POSTs are issued by the worker).
  const apiPath = new URL(apiUrl).pathname;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(apiPath)) requestCount++;
  });

  const failures = [];
  try {
    // 1) Home (also handles the password gate up-front).
    await goto(page, "/", "home");

    // 2) A collection.
    await goto(page, "/collections/all", "collection");

    // 3) A product page. Prefer scraping a real product link from the
    //    collection page so the test survives catalog changes.
    let productPath = null;
    try {
      productPath = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/products/"]');
        return link ? new URL(link.href).pathname : null;
      });
    } catch { /* fall through to the known default below */ }
    if (!productPath) {
      productPath = "/products/the-collection-snowboard-liquid";
      warn(`no product link found on the collection page - falling back to ${productPath}`);
    }
    await goto(page, productPath, "product");

    // 4) Storefront search (this is /search?q= which fires search_submitted).
    await goto(
      page,
      `/search?q=${encodeURIComponent(SEARCH_TERM)}`,
      `search "${SEARCH_TERM}"`,
    );

    // 5) Add to cart. Theme-dependent: try the standard product form button,
    //    then just assert the cart was reachable afterwards.
    const addBtn = page
      .locator('button[name="add"], button[type="submit"][form*="product"], .product-form__submit, .shopify-payment-button__button--unbranded')
      .first();
    if ((await addBtn.count()) > 0) {
      try {
        await addBtn.click({ timeout: 10_000 });
        await page.waitForTimeout(2500);
        log("clicked add-to-cart");
      } catch (e) {
        warn(`add-to-cart click failed (${e.message.split("\n")[0]}) - continuing; product_added_to_cart may be missing from this run.`);
      }
    } else {
      warn("no add-to-cart button found - product_added_to_cart will not fire this run.");
    }

    // Let fire-and-forget keepalive POSTs land.
    log(`settling ${SETTLE_MS}ms for fire-and-forget POSTs to land...`);
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    failures.push(`browser phase: ${e.message.split("\n")[0]}`);
  } finally {
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = `${SHOT_DIR}/final-${Date.now()}.png`;
    try { await page.screenshot({ path: shot }); } catch { /* best effort */ }
    await context.close();
    await browser.close();
  }

  // ---- Re-check DB ----------------------------------------------------------
  const after = await dbCounts(SHOP);
  const dEvents = after.events - baseline.events;
  const dVisitors = after.visitors - baseline.visitors;

  // Persist-error visibility: the ingestion route logs
  // "[api.events] failed to persist event" — surface anything captured.
  // (Server logs live in the `npm run dev` terminal; here we can only infer:
  // if requests were sent but counts did not move, that is the signature.)
  const requestsButNoRows = requestCount > 0 && dEvents === 0;
  if (requestsButNoRows) {
    warn(
      `${requestCount} POST(s) reached ${apiPath} but event count did not increase. ` +
        "Check the `npm run dev` terminal for `[api.events] failed to persist event` " +
        "(most likely cause: FK violation = no shops row / missing OAuth install).",
    );
  }

  const expectedEvents = 3; // minimum meaningful signal (each page fires page_viewed)
  const checks = [
    {
      name: "events increased",
      pass: dEvents >= expectedEvents,
      detail: `+${dEvents} (baseline ${baseline.events} -> ${after.events})`,
    },
    {
      name: "visitors increased",
      pass: dVisitors >= 1,
      detail: `+${dVisitors} (baseline ${baseline.visitors} -> ${after.visitors})`,
    },
    {
      name: "events landed (POSTs observed or rows grew)",
      // DB growth is ground truth; the page-level network log may not surface
      // worker-issued fetches on every Playwright/browser version.
      pass: requestCount > 0 || dEvents > 0,
      detail: `${requestCount} POST(s) seen to ${apiPath}; rows +${dEvents}`,
    },
    {
      name: "pixel worker executed (PD pixel: logs)",
      pass: pixelLogs.length > 0,
      detail: `${pixelLogs.length} log line(s)`,
    },
  ];

  console.log("\n================= SMOKE TEST SUMMARY =================");
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  }
  if (pixelLogs.length) {
    console.log("--- captured pixel worker logs ---");
    for (const l of pixelLogs.slice(0, 30)) console.log("  " + l);
    if (pixelLogs.length > 30) console.log(`  … ${pixelLogs.length - 30} more`);
  }
  if (warnings.length) {
    console.log("--- warnings ---");
    for (const w of warnings) console.log("  " + w);
  }
  console.log("======================================================\n");

  const passed = checks.every((c) => c.pass) && failures.length === 0;
  for (const f of failures) console.error(`[smoke] FAILURE: ${f}`);
  log(passed ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");
  await prisma.$disconnect();
  process.exit(passed ? 0 : 1);
}

main().catch(async (e) => {
  console.error("[smoke] fatal:", e);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});

