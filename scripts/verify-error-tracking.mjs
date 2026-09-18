/**
 * Error-tracking + structured-logging verification — alerting path only.
 *
 * PROVES, against the real code (not mocks of the app logic):
 *   1. Every logError/logWarn call emits one structured JSON line with
 *      ts/level/module/shop_domain (captured by intercepting console).
 *   2. Every error-level call AND the revenue-mismatch warn fan out to
 *      Sentry — asserted via an injected fake client (no network, no DSN).
 *   3. Real failure paths fire those signals end to end: a mismatching
 *      orders/paid webhook (trust-claim signal), a malformed webhook payload
 *      (no order id), a failed stale sweep (simulated DB outage), and a
 *      product-sync outage (simulated Admin failure).
 *   4. initSentry() without a DSN is a silent no-op (local dev safe).
 *   5. Global handlers (uncaughtException/unhandledRejection safety net)
 *      forward to Sentry.
 *
 * WHAT THIS DOES NOT PROVE (needs a real DSN — see task notes): that events
 * land in the Sentry dashboard. The fake client records the exact payloads
 * that WOULD be sent; paste a free-tier DSN and the same code path sends
 * them for real with zero code changes.
 *
 * Run: node --experimental-strip-types scripts/verify-error-tracking.mjs
 */
import { PrismaClient } from "@prisma/client";
import {
  __resetSentryForTests,
  initSentry,
  installGlobalHandlers,
  isSentryActive,
} from "../app/utils/sentry.server.ts";
import { logError, logInfo, logWarn } from "../app/utils/logger.server.ts";
import {
  sweepStaleVerifications,
  verifyPaidOrder,
} from "../app/utils/order-verification.server.ts";
import {
  ensureShopProductsReconciled,
  reconcileShopProducts,
} from "../app/utils/product-sync.server.ts";

process.loadEnvFile(".env");

const db = new PrismaClient();

// ---------------------------------------------------------------------------
// Fake Sentry client: records exactly what would be sent, no network.
// ---------------------------------------------------------------------------
const sent = { exceptions: [], messages: [] };
const fakeClient = {
  captureException: (err, ctx) => {
    sent.exceptions.push({ message: err?.message ?? String(err), ctx });
    return "fake-id-exception";
  },
  captureMessage: (msg, ctx) => {
    sent.messages.push({ message: msg, ctx });
    return "fake-id-message";
  },
};

// ---------------------------------------------------------------------------
// console intercept: capture every structured JSON line the logger emits.
// ---------------------------------------------------------------------------
const lines = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...a) => { lines.push({ stream: "log", text: String(a[0]) }); };
console.warn = (...a) => { lines.push({ stream: "warn", text: String(a[0]) }); };
console.error = (...a) => { lines.push({ stream: "error", text: String(a[0]) }); };

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; origLog(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; origLog(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

function isStructured(text, want) {
  let o;
  try { o = JSON.parse(text); } catch { return false; }
  if (typeof o.ts !== "string" || Number.isNaN(Date.parse(o.ts))) return false;
  if (o.level !== want.level || o.module !== want.module) return false;
  if (want.shop !== undefined && o.shop_domain !== want.shop) return false;
  if (typeof o.message !== "string" || !o.message.includes(want.msgPart)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// [0] initSentry without DSN is a silent no-op; with fake client activates.
// ---------------------------------------------------------------------------
origLog("[0] no-DSN init is a no-op; fake client activates");
__resetSentryForTests();
delete process.env.SENTRY_DSN;
check("initSentry() without DSN returns false", initSentry() === false);
check("inactive without DSN", isSentryActive() === false);
logError({ module: "verify-harness", shop_domain: "x.myshopify.com" }, "no-client error", new Error("boom"));
check("no Sentry capture without client", sent.exceptions.length === 0);
check(
  "console still gets the structured line without Sentry",
  lines.some((l) => isStructured(l.text, { level: "error", module: "verify-harness", shop: "x.myshopify.com", msgPart: "no-client error" })),
);
__resetSentryForTests();
check("initSentry with fake client returns true", initSentry({ client: fakeClient, skipGlobalHandlers: true }) === true);
check("active with fake client", isSentryActive() === true);

// ---------------------------------------------------------------------------
// [1] logger primitives: info/warn/error JSON shape + Sentry fan-out rules.
// ---------------------------------------------------------------------------
origLog("[1] logger primitives emit structured JSON; only errors fan out");
lines.length = 0;
sent.exceptions.length = 0;
sent.messages.length = 0;

logInfo({ module: "m", shop_domain: "s.myshopify.com" }, "hello info");
check(
  "info -> one JSON line, no Sentry",
  lines.some((l) => isStructured(l.text, { level: "info", module: "m", shop: "s.myshopify.com", msgPart: "hello info" })) &&
    sent.exceptions.length === 0 && sent.messages.length === 0,
);
logWarn({ module: "m", shop_domain: "s.myshopify.com" }, "plain warn");
check(
  "plain warn -> JSON line, NO Sentry by default",
  lines.some((l) => isStructured(l.text, { level: "warn", module: "m", shop: "s.myshopify.com", msgPart: "plain warn" })) &&
    sent.messages.length === 0,
);
logWarn({ module: "m", shop_domain: "s.myshopify.com" }, "sentry warn", { sentry: true });
check(
  "opt-in warn -> JSON line + Sentry message",
  lines.some((l) => isStructured(l.text, { level: "warn", module: "m", shop: "s.myshopify.com", msgPart: "sentry warn" })) &&
    sent.messages.length === 1 && sent.messages[0].message.includes("sentry warn"),
);
logError({ module: "m", shop_domain: "s.myshopify.com" }, "bad thing", new Error("kaboom"));
check(
  "error -> JSON line + Sentry exception with error_message",
  lines.some((l) => {
    let o;
    try { o = JSON.parse(l.text); } catch { return false; }
    return o.level === "error" && o.module === "m" && o.error_message === "kaboom";
  }) && sent.exceptions.length === 1 && sent.exceptions[0].message === "kaboom",
);

const SHOP = "pd-errtrack-verify.myshopify.com";
const STAMP = String(Date.now()).slice(-7);
const VISITOR = `00000000-0000-4000-8000-${STAMP.padStart(12, "0")}`;

async function ensureShop() {
  await db.shops.upsert({
    where: { shop_domain: SHOP },
    update: {},
    create: {
      shop_domain: SHOP,
      access_token: "verify-harness-no-real-token",
      scopes: "read_products",
    },
  });
  try {
    await db.visitors.upsert({
      where: { visitor_id: VISITOR },
      update: {},
      create: { visitor_id: VISITOR, shop_domain: SHOP },
    });
  } catch { /* visitor may already exist across runs */ }
}

async function cleanup() {
  const del = await db.events.deleteMany({ where: { shop_domain: SHOP } });
  try { await db.visitors.deleteMany({ where: { shop_domain: SHOP } }); } catch { /* keep */ }
  try { await db.products.deleteMany({ where: { shop_domain: SHOP } }); } catch { /* keep */ }
  try { await db.shops.deleteMany({ where: { shop_domain: SHOP } }); } catch { /* keep */ }
  return del.count;
}

// ---------------------------------------------------------------------------
// [2] revenue MISMATCH path: real verifyPaidOrder -> structured warn +
// Sentry message (the trust-claim signal must never hide in traffic).
// ---------------------------------------------------------------------------
origLog("[2] mismatching orders/paid webhook -> JSON warn + Sentry message");
await ensureShop();
lines.length = 0;
sent.exceptions.length = 0;
sent.messages.length = 0;

const o2 = `97${STAMP}21`;
const p2 = `98${STAMP}21`;
await db.events.create({
  data: { visitor_id: VISITOR, shop_domain: SHOP, event_type: "checkout_completed", product_id: p2, order_id: o2, revenue: 10 },
});
const r2 = await verifyPaidOrder(db, SHOP, {
  id: Number(o2),
  line_items: [{ product_id: Number(p2), price: "12.50", quantity: 1 }],
});
check("mismatch detected, webhook wins", r2.mismatchRows === 1 && r2.verifiedRows === 0);
check(
  "MISMATCH warn is structured JSON with amounts",
  lines.some((l) => {
    let o;
    try { o = JSON.parse(l.text); } catch { return false; }
    return o.level === "warn" && o.module === "order-verification" && o.shop_domain === SHOP &&
      typeof o.message === "string" && o.message.includes("MISMATCH") &&
      o.browser_amount === 10 && o.webhook_amount === 12.5 && o.diff === 2.5;
  }),
);
check(
  "MISMATCH fanned out to Sentry as a message",
  sent.messages.length === 1 && sent.messages[0].message.includes("MISMATCH") &&
    sent.messages[0].ctx?.extra?.shop_domain === SHOP,
  JSON.stringify(sent.messages[0] ?? null),
);

// ---------------------------------------------------------------------------
// [3] malformed webhook payload (no order id) + failed sweep (DB outage) +
// product-sync outage (Admin failure): every error fans out to Sentry.
// ---------------------------------------------------------------------------
origLog("[3] malformed payload + sweep outage + sync outage -> Sentry errors");
lines.length = 0;
sent.exceptions.length = 0;
sent.messages.length = 0;

const r3 = await verifyPaidOrder(db, SHOP, { line_items: [] });
check("malformed payload skipped, no throw", r3.matchedRows === 0 && r3.order_id === "");
check(
  "malformed payload logged as structured warn AND fanned out to Sentry",
  lines.some((l) => isStructured(l.text, { level: "warn", module: "order-verification", shop: SHOP, msgPart: "no numeric order id" })) &&
    sent.messages.length === 1 && sent.messages[0].ctx?.extra?.malformed_webhook === true,
  JSON.stringify(sent.messages[0] ?? null),
);

const brokenDb = {
  events: {
    findMany: async () => { throw new Error("simulated outage"); },
    updateMany: async () => { throw new Error("simulated sweep outage"); },
  },
};
const sweep = await sweepStaleVerifications(brokenDb, SHOP);
check("sweep degrades to {marked: 0}", sweep.marked === 0);
check(
  "sweep failure -> structured error JSON + Sentry exception",
  lines.some((l) => isStructured(l.text, { level: "error", module: "order-verification", shop: SHOP, msgPart: "sweep FAILED" })) &&
    sent.exceptions.length === 1 && sent.exceptions[0].message.includes("simulated sweep outage"),
);

const brokenAdmin = {
  graphql: async () => { throw new Error("simulated Admin API outage"); },
};
let syncThrew = false;
try {
  await reconcileShopProducts(db, SHOP, brokenAdmin);
} catch (e) {
  syncThrew = true;
  check("sync outage message preserved", String(e?.message ?? e).includes("simulated Admin API outage"));
}
check("sync outage throws (caller decides retry)", syncThrew === true);
// The app never calls reconcileShopProducts directly — api.proxy.$.tsx calls
// ensureShopProductsReconciled (the daily cadence gate), and THAT is where the
// outage is logged + reported. Drive the real path so this assertion covers
// the wiring the app actually uses, not just the raw throw.
const gate = await ensureShopProductsReconciled(db, SHOP, brokenAdmin);
check(
  "sync outage -> cadence gate degrades to {ran:false, error:true}",
  gate.ran === false && gate.error === true,
  JSON.stringify(gate),
);
check(
  "sync outage -> Sentry exception",
  sent.exceptions.some((x) => x.message.includes("simulated Admin API outage")),
  JSON.stringify(sent.exceptions.map((x) => x.message)),
);

// ---------------------------------------------------------------------------
// [4] global safety net: uncaughtException + unhandledRejection -> Sentry.
// A child process installs the real handlers with the fake client, then
// crashes both ways; the parent asserts the fake captured both.
// ---------------------------------------------------------------------------
origLog("[4] global handlers forward uncaught errors to Sentry");
{
  // A child process installs the real handlers with a fake client, then
  // crashes both ways; the parent asserts the fake captured both.
  const cp = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-errtrack-"));
  const probeFile = path.join(dir, "probe.mjs");
  const outFile = path.join(dir, "out.json");
  // The probe lives in a temp dir, so it must import the module by URL.
  // A bare Windows path ("C:/...") is NOT a valid ESM specifier —
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — so convert to file:// first.
  const sentryUrl = pathToFileURL(
    path.join(process.cwd(), "app", "utils", "sentry.server.ts"),
  ).href;
  fs.writeFileSync(
    probeFile,
    [
      'import { installGlobalHandlers } from ' + JSON.stringify(sentryUrl) + ";",
      "const sent = [];",
      "installGlobalHandlers({",
      "  captureException: (e, ctx) => { sent.push({ m: e && e.message, k: ctx && ctx.extra && ctx.extra.kind }); },",
      "  captureMessage: () => {},",
      "});",
      'const { writeFileSync } = await import("node:fs");',
      "let done = 0;",
      "function maybeDone() { if (++done === 2) { writeFileSync(process.env.PROBE_OUT, JSON.stringify(sent)); process.exit(0); } }",
      'process.on("uncaughtException", () => maybeDone());',
      'process.on("unhandledRejection", () => maybeDone());',
      'setTimeout(() => { Promise.reject(new Error("probe-rejection")); }, 50);',
      'setTimeout(() => { throw new Error("probe-exception"); }, 150);',
      'setTimeout(() => { try { writeFileSync(process.env.PROBE_OUT, JSON.stringify(sent)); } catch {} process.exit(2); }, 8000);',
    ].join("\n"),
  );
  const res = cp.spawnSync(process.execPath, ["--experimental-strip-types", probeFile], {
    env: { ...process.env, PROBE_OUT: outFile },
    encoding: "utf8",
  });
  let captured = [];
  try { captured = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { captured = []; }
  const kinds = new Set(captured.map((c) => c.k));
  check("probe child exited cleanly after capturing", res.status === 0, `status=${res.status}`);
  check("uncaughtException forwarded", kinds.has("uncaughtException"));
  check("unhandledRejection forwarded", kinds.has("unhandledRejection"));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// [5] alert throttle: high-volume rejections alert ONCE per window, never zero
// times (the first occurrence always fires) — a burst cannot bury other alerts.
// ---------------------------------------------------------------------------
origLog("[5] alert throttle: first fires, repeats suppressed, next window fires");
{
  const { shouldAlertToSentry, __resetAlertThrottleForTests } = await import(
    "../app/utils/alert-throttle.server.ts"
  );
  __resetAlertThrottleForTests();
  const T = 5_000_000;
  check("first occurrence always alerts", shouldAlertToSentry("k", 60_000, T).alert === true);
  check("repeat inside window suppressed", shouldAlertToSentry("k", 60_000, T + 1_000).alert === false);
  const d2 = shouldAlertToSentry("k", 60_000, T + 2_000);
  check("suppressed counter increments", d2.alert === false && d2.suppressed === 2);
  const after = shouldAlertToSentry("k", 60_000, T + 60_001);
  check("first call after the window alerts again and reports the count", after.alert === true && after.suppressed === 2);
  check("throttle keys are independent", shouldAlertToSentry("other", 60_000, T).alert === true);
}

// ---------------------------------------------------------------------------
// [6] the app-proxy HMAC gate is Sentry-visible but throttled: 3 fast 401s
// produce 3 console lines and exactly 1 Sentry alert (noise control, not
// silence). Mirrors the exact call shape used in api.proxy.$.tsx.
// ---------------------------------------------------------------------------
origLog("[6] proxy HMAC 401s -> every console line, one throttled Sentry alert");
{
  const { shouldAlertToSentry, __resetAlertThrottleForTests } = await import(
    "../app/utils/alert-throttle.server.ts"
  );
  __resetAlertThrottleForTests();
  lines.length = 0;
  sent.exceptions.length = 0;
  sent.messages.length = 0;
  const reject = () => {
    const gate = shouldAlertToSentry("api.proxy.hmac_rejected", 10 * 60 * 1000);
    return logWarn(
      {
        module: "api.proxy.assign",
        extra: {
          status: 401,
          proxy_query: "shop=x.myshopify.com&signature=bad",
          suppressed_since_last_alert: gate.suppressed,
        },
      },
      "[api.proxy.assign] rejected unverified request (HMAC/signature gate): status=401",
      { sentry: gate.alert },
    );
  };
  reject();
  reject();
  reject();
  const proxyLines = lines.filter((l) => l.text.includes("rejected unverified request"));
  check("all 3 rejections printed (nothing hidden locally)", proxyLines.length === 3);
  check("exactly 1 Sentry alert for the burst", sent.messages.length === 1, `sent=${sent.messages.length}`);
  check(
    "alert carries the structured 401 context",
    sent.messages[0]?.ctx?.extra?.status === 401 && sent.messages[0]?.ctx?.extra?.proxy_query !== undefined,
    JSON.stringify(sent.messages[0] ?? null),
  );
}

// ---------------------------------------------------------------------------
// [7] unknown-shop divergence -> Sentry (install state is wrong; a human must
// look), while still degrading to {ran:false} and never calling the Admin API.
// ---------------------------------------------------------------------------
origLog("[7] unknown shop -> structured warn + Sentry message, no Admin call");
{
  const UNKNOWN = `errtrack-unknown-${Date.now()}.myshopify.com`;
  lines.length = 0;
  sent.exceptions.length = 0;
  sent.messages.length = 0;
  let adminCalled = false;
  const res = await ensureShopProductsReconciled(db, UNKNOWN, {
    graphql: async () => {
      adminCalled = true;
      throw new Error("must not be called");
    },
  });
  check("unknown shop -> {ran:false}", res.ran === false);
  check("unknown shop never hits the Admin API", adminCalled === false);
  check(
    "unknown shop -> structured warn + Sentry message",
    lines.some((l) =>
      isStructured(l.text, { level: "warn", module: "product-sync", shop: UNKNOWN, msgPart: "not installed locally" }),
    ) &&
      sent.messages.length === 1 &&
      sent.messages[0].ctx?.extra?.unknown_shop === true,
    JSON.stringify(sent.messages[0] ?? null),
  );
}

// ---------------------------------------------------------------------------
// [8] static guarantee: no ad-hoc console.* remains in the pipeline files —
// each one goes through app/utils/logger.server.ts, so console output is a
// structured JSON line and the error/warn fan-out to Sentry applies.
// ---------------------------------------------------------------------------
origLog("[8] no raw console.* calls remain in the pipeline files");
{
  const fs = await import("node:fs");
  const PIPELINE = [
    "app/routes/api.events.tsx",
    "app/routes/api.proxy.$.tsx",
    "app/routes/app.pixel.tsx",
    "app/utils/product-sync.server.ts",
    "app/utils/order-verification.server.ts",
    "app/utils/pixel-resync.server.ts",
    "app/utils/thompson-sampling.ts",
    "app/routes/webhooks.orders.paid.tsx",
    "app/routes/webhooks.products.create.tsx",
    "app/routes/webhooks.products.update.tsx",
    "app/routes/webhooks.products.delete.tsx",
    "app/routes/webhooks.inventory_levels.update.tsx",
    "app/routes/webhooks.app.uninstalled.tsx",
    "app/routes/webhooks.app.scopes_update.tsx",
    "app/routes/webhooks.shop.redact.tsx",
    "app/routes/webhooks.customers.redact.tsx",
    "app/routes/webhooks.customers.data_request.tsx",
    "app/entry.server.tsx",
  ];
  // Strip comments first: several of these files DOCUMENT the old console
  // behavior in prose, which must not count as a live call site.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const offenders = [];
  for (const rel of PIPELINE) {
    const src = stripComments(fs.readFileSync(rel, "utf8"));
    const hits = src.match(/console\s*\.\s*(log|warn|error|info|debug)\s*\(/g);
    if (hits) offenders.push(`${rel} (${hits.length})`);
  }
  check("zero raw console.* in pipeline files", offenders.length === 0, offenders.join("; "));
  const wrapper = fs.readFileSync("app/utils/logger.server.ts", "utf8");
  check("logger.server.ts is the single console boundary", /console\.error\(text\)/.test(wrapper));
}

// ---------------------------------------------------------------------------
// Cleanup + result.
// ---------------------------------------------------------------------------
const removed = await cleanup();
console.log = origLog; console.warn = origWarn; console.error = origError;
origLog(`[cleanup] synthetic events removed: ${removed}`);
check("cleanup removed every synthetic row", (await db.events.count({ where: { shop_domain: SHOP } })) === 0);
await db.$disconnect();

origLog(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);






