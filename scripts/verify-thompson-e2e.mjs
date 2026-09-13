/**
 * End-to-end verification: Thompson Sampling wired into live collection
 * merchandising (task: replace the placeholder sort override).
 *
 * What it proves, against a REAL booted app server (react-router-serve) and
 * the real database:
 *   1.  A forged-but-valid app-proxy signature is accepted; a tampered one
 *       is rejected with 401 (signature gate on /api/proxy/rank).
 *   2.  The daily rollup populates product_surface_stats from seeded raw
 *       events via computeAttribution(windowDays: 30) semantics:
 *       impressions per product on the instance, purchases = DISTINCT
 *       assigned visitors within [assigned_at, assigned_at + 30d], revenue
 *       summed over the same window. Backwards/late/non-assigned/out-of-
 *       window checkouts are excluded. Products with zero impressions get
 *       NO stats row (they join the ranking as zero-history candidates).
 *   3.  A treatment-visitor ranking request draws once (drew=true), includes
 *       ALL products (zero-impression included), and a second call the same
 *       UTC day returns the IDENTICAL cached order (drew=false).
 *   4.  Arm gating stays client-side and correct: the exported pure core
 *       shouldApplyRanking() is true ONLY for treatment + collection page +
 *       no explicit sort_by; control visitors (and shoppers who picked a
 *       sort) keep the default order — verified from the actual extension
 *       asset evaluated in a Node VM harness.
 *
 * Usage:
 *   node scripts/verify-thompson-e2e.mjs
 * Env: reads .env (DATABASE_URL, SHOPIFY_API_SECRET). Builds the app first
 * if build/server/index.js is missing.
 */
import process from "node:process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";

process.loadEnvFile(".env");
const require = createRequire(import.meta.url);
const db = new PrismaClient();

const ROOT = process.cwd();
const PORT = process.env.VERIFY_PORT || 3789;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.SHOPIFY_API_SECRET;
if (!SECRET) {
  console.error("FATAL: SHOPIFY_API_SECRET missing from .env");
  process.exit(1);
}

// Synthetic instance — nothing real is touched; everything is cascade-deleted
// via the shops row in cleanup().
const SHOP = `thompson-e2e-${Date.now()}.myshopify.com`;
const SURFACE = "collection";
const REF = "e2e-thompson-collection";

// Shopify canonical product ids are NUMERIC strings (that's what the rank
// request's product_ids filter and the client's card-id resolution accept).
const P1 = "9000001"; // winner: 10 impressions, 2 conversions
const P2 = "9000002"; // 4 impressions, 0 conversions
const P3 = "9000003"; // 1 impression, 0 conversions
const P4 = "9000004"; // ZERO impressions -> no stats row, still ranked
const EXCLUDED_PID = "9000005"; // is_excluded: true -> NEVER ranked
const OOS_PID = "9000006"; // inventory_available: 0 -> NEVER ranked
const UNMATCHED_PID = "9000007"; // in-stock, has COLLECTION stats, NOT a search match
const SEARCH_REF = "e2e-query"; // the synthetic search query (surface=search)

const TREAT = randomUUID(); // treatment-arm visitor (seeded assignment)
const CTRL = randomUUID(); // control-arm visitor (seeded assignment)
const BUYER2 = randomUUID(); // second treatment buyer -> distinct conversion
const BUYER3 = randomUUID(); // assigned nowhere -> purchases must exclude

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

// ---------------------------------------------------------------------------
// App-proxy signature (mirrors Shopify's canonicalization exactly:
// sorted key=value concat, HMAC-SHA256 hex, timestamp +-90s).
// ---------------------------------------------------------------------------
function signedQuery(extra) {
  const params = { ...extra, timestamp: String(Math.floor(Date.now() / 1000)) };
  const keys = Object.keys(params).sort((a, b) => a.localeCompare(b));
  const base = keys.map((k) => `${k}=${params[k]}`).join("");
  const signature = createHmac("sha256", SECRET).update(base).digest("hex");
  const qs = new URLSearchParams(params);
  qs.set("signature", signature);
  return qs.toString();
}

async function getRank(
  visitorId,
  { tamper = false, surface = SURFACE, surfaceRef = REF, productIds = null } = {},
) {
  const params = {
    visitor_id: visitorId,
    surface,
    surface_ref: surfaceRef,
    shop: SHOP,
  };
  if (productIds !== null) params.product_ids = productIds;
  const qs = signedQuery(params);
  const suffix = tamper ? "0" : "";
  const response = await fetch(`${BASE}/api/proxy/rank?${qs}${suffix}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON error body
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let server = null;
async function startServer() {
  if (!existsSync(path.join(ROOT, "build", "server", "index.js"))) {
    console.log("  build/server/index.js missing — running npm run build ...");
    const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
    if (built.status !== 0) throw new Error("npm run build failed");
  }
  server = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      // .env leaves SHOPIFY_APP_URL empty in dev; the proxy route never uses
      // it, so point it at the local server to satisfy requireEnv().
      SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true, // npm shim resolution on win32
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.env.VERIFY_VERBOSE && process.stderr.write(d));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    try {
      await fetch(BASE); // any HTTP response (even 404) means it's listening
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("server did not start listening within 90s");
}

function stopServer() {
  if (!server) return;
  try {
    if (process.platform === "win32") {
      // shim chains: kill the whole tree
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Extension pure core (the actual asset, evaluated in a VM harness so the
// browser-only sections stay dormant but module.exports is honored).
// ---------------------------------------------------------------------------
function loadExtensionCore() {
  const src = readFileSync(
    path.join(ROOT, "extensions", "pd-treatment", "assets", "pd-treatment.js"),
    "utf8",
  );
  const mod = { exports: {} };
  const sandbox = Object.create(globalThis);
  sandbox.module = mod;
  sandbox.require = require;
  sandbox.console = console;
  vm.runInNewContext(src, sandbox, { filename: "pd-treatment.js" });
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Seed / cleanup
// ---------------------------------------------------------------------------
async function cleanup() {
  // Every FK cascades from shops (onDelete: Cascade) — one delete clears all.
  await db.shops.deleteMany({ where: { shop_domain: SHOP } });
}

async function seed() {
  await db.shops.create({
    data: {
      shop_domain: SHOP,
      access_token: "e2e-not-a-real-token",
      scopes: "read_products",
    },
  });
  const now = Date.now();
  const assignedAt = new Date(now - 2 * 24 * 3600 * 1000); // 2 days ago

  const P5 = EXCLUDED_PID; // merchant-excluded (is_excluded: true), has stats
  const P6 = OOS_PID; // out-of-stock (inventory_available: 0), has stats
  await db.products.createMany({
    data: [
      { id: P1, overrides: {} },
      { id: P2, overrides: {} },
      { id: P3, overrides: {} },
      { id: P4, overrides: {} },
      // Excluded on purpose: merchant opted it out despite healthy stats.
      { id: P5, overrides: { is_excluded: true, inventory_available: 25 } },
      // Out of stock on purpose: in stock nowhere, must not be ranked.
      { id: P6, overrides: { inventory_available: 0 } },
      // Never matched by the (synthetic) search query — in stock, will get
      // COLLECTION-surface stats only. Must never be ranked on the search
      // surface: this is the candidate-scoping proof.
      { id: UNMATCHED_PID, overrides: {} },
    ].map(({ id, overrides }, i) => ({
      product_id: id,
      shop_domain: SHOP,
      title: `E2E Thompson Product ${i + 1}`,
      price: (i + 1) * 10,
      created_at: new Date(now),
      inventory_available: 10,
      ...overrides,
    })),
  });
  await db.visitors.createMany({
    data: [TREAT, CTRL, BUYER2, BUYER3].map((visitor_id) => ({
      visitor_id,
      shop_domain: SHOP,
    })),
  });
  // Seeded assignments (rows written directly so the deterministic-hash arm
  // does not gate the test — the API itself never writes here in this flow).
  await db.experiment_assignments.createMany({
    data: [
      { visitor_id: TREAT, variant: "treatment" },
      { visitor_id: CTRL, variant: "control" },
      { visitor_id: BUYER2, variant: "treatment" },
    ].map((a) => ({
      ...a,
      shop_domain: SHOP,
      surface: SURFACE,
      surface_ref: REF,
      experiment_id: randomUUID(),
      assigned_at: assignedAt,
    })),
  });

  const at = (offsetDays) => new Date(now + offsetDays * 24 * 3600 * 1000);
  const impression = (
    visitor_id,
    product_id,
    offsetDays,
    sfc = SURFACE,
    sref = REF,
  ) => ({
    visitor_id,
    shop_domain: SHOP,
    event_type: "product_impression",
    product_id,
    surface: sfc,
    surface_ref: sref,
    occurred_at: at(offsetDays),
  });
  const checkout = (visitor_id, product_id, revenue, offsetDays) => ({
    visitor_id,
    shop_domain: SHOP,
    event_type: "checkout_completed",
    product_id,
    revenue,
    surface: SURFACE,
    surface_ref: REF,
    occurred_at: at(offsetDays),
  });

  const events = [];
  for (let i = 0; i < 10; i++) events.push(impression(TREAT, P1, -1));
  for (let i = 0; i < 4; i++) events.push(impression(TREAT, P2, -1));
  events.push(impression(TREAT, P3, -1));
  // P4: deliberately zero impressions.
  // P5 (excluded) and P6 (out-of-stock) GET impressions on purpose: their
  // product_surface_stats rows will exist, proving the candidate filter (not
  // missing data) is what keeps them out of the ranking.
  for (let i = 0; i < 5; i++) events.push(impression(TREAT, EXCLUDED_PID, -1));
  for (let i = 0; i < 4; i++) events.push(impression(TREAT, OOS_PID, -1));
  // Search-surface instance: P1 is a real Shopify match for the query (gets
  // search impressions -> search stats); UNMATCHED gets COLLECTION impressions
  // only (stats exist there, but it is NOT in the search match set).
  for (let i = 0; i < 5; i++) {
    events.push(impression(TREAT, P1, -1, "search", SEARCH_REF));
  }
  for (let i = 0; i < 3; i++) events.push(impression(TREAT, UNMATCHED_PID, -1));

  // In-window purchases: two DISTINCT treatment visitors -> purchases = 2.
  events.push(checkout(TREAT, P1, "25.50", -1));
  events.push(checkout(BUYER2, P1, "40.00", -1));
  // Negative controls (must ALL be excluded):
  events.push(checkout(TREAT, P1, "10.00", -3)); // before assigned_at
  events.push(checkout(TREAT, P1, "99.00", 45)); // outside the 30d window
  events.push(checkout(BUYER3, P1, "5.00", -1)); // visitor not assigned here

  await db.events.createMany({ data: events });
  return events.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Thompson Sampling E2E verification ===`);
  console.log(`  shop: ${SHOP}\n  instance: ${SURFACE}/${REF}\n`);

  console.log("[setup] seeding synthetic events ...");
  await cleanup();
  const eventCount = await seed();
  console.log(`  seeded ${eventCount} events, 7 products, 3 assignments\n`);

  console.log("[boot] starting app server on port " + PORT + " ...");
  await startServer();
  console.log("  server is up\n");

  // --- 1. Signature gate --------------------------------------------------
  console.log("[1] app-proxy signature gate");
  const bad = await getRank(TREAT, { tamper: true });
  check("tampered signature rejected with 401", bad.status === 401, `status=${bad.status}`);

  // --- 2. First ranking request: rollup + fresh draw -----------------------
  console.log("[2] first rank request (triggers once-per-day rollup + draw)");
  const first = await getRank(TREAT);
  check("first request is 200", first.status === 200, `status=${first.status}`);
  const ranking1 = first.body && first.body.ranking;
  check(
    "ranking returned as array",
    Array.isArray(ranking1) && ranking1.length > 0,
    `len=${ranking1 && ranking1.length}`,
  );
  check("first call reports a fresh draw (drew=true)", !!first.body && first.body.drew === true);
  check(
    "date_utc is today",
    !!first.body && first.body.date_utc === new Date().toISOString().slice(0, 10),
    first.body && first.body.date_utc,
  );
  const asSet = new Set(ranking1 || []);
  check("zero-impression product P4 included (uninformative prior protects it)", asSet.has(P4));
  check(
    "all ELIGIBLE collection products ranked (P1-P4 + unmatched-in-stock; excluded & OOS filtered)",
    asSet.size === 5 &&
      asSet.has(P1) &&
      asSet.has(P2) &&
      asSet.has(P3) &&
      asSet.has(UNMATCHED_PID),
    `size=${asSet.size}`,
  );
  check(
    "merchant-excluded product (is_excluded) NEVER appears in the ranking",
    !asSet.has(EXCLUDED_PID),
  );
  check(
    "out-of-stock product (inventory_available = 0) NEVER appears in the ranking",
    !asSet.has(OOS_PID),
  );

  // --- 3. Rollup correctness ----------------------------------------------
  console.log("[3] product_surface_stats rollup");
  const stats = await db.product_surface_stats.findMany({
    where: { shop_domain: SHOP, surface: SURFACE, surface_ref: REF },
  });
  const byP = new Map(stats.map((s) => [s.product_id, s]));
  const s1 = byP.get(P1);
  const s2 = byP.get(P2);
  const s3 = byP.get(P3);
  check("P1 stats row exists", !!s1);
  check("P1 impressions = 10", !!s1 && s1.impressions === 10, s1 && String(s1.impressions));
  check(
    "P1 purchases = 2 (distinct assigned visitors, 30d window)",
    !!s1 && s1.purchases === 2,
    s1 && String(s1.purchases),
  );
  check(
    "P1 revenue = 65.50 (excludes pre-assignment/late/unassigned checkouts)",
    !!s1 && Math.abs(Number(s1.revenue) - 65.5) < 0.005,
    s1 && String(s1.revenue),
  );
  check("P2 stats: 4 impressions, 0 purchases", !!s2 && s2.impressions === 4 && s2.purchases === 0);
  check("P3 stats: 1 impression", !!s3 && s3.impressions === 1);
  check("P4 has NO stats row (zero impressions) but IS ranked", !byP.has(P4) && asSet.has(P4));
  // P5/P6 stats rows MUST exist (the rollup is unfiltered by design — this
  // proves the candidate filter, not missing data, keeps them unranked).
  const s5 = byP.get(EXCLUDED_PID);
  const s6 = byP.get(OOS_PID);
  check(
    "excluded product HAS a stats row (5 impressions) — rollup untouched, filter is candidate-stage",
    !!s5 && s5.impressions === 5,
    s5 && String(s5.impressions),
  );
  check(
    "out-of-stock product HAS a stats row (4 impressions) — same",
    !!s6 && s6.impressions === 4,
    s6 && String(s6.impressions),
  );
  const su = byP.get(UNMATCHED_PID);
  check(
    "unmatched product HAS collection stats (3 impressions) — yet is never search-ranked (see [6])",
    !!su && su.impressions === 3,
    su && String(su.impressions),
  );

  // --- 4. Daily cache: same visitor/day => identical order -----------------
  console.log("[4] daily ranking cache");
  const second = await getRank(TREAT);
  check("second request is 200", second.status === 200);
  check("second call is a cache hit (drew=false)", !!second.body && second.body.drew === false);
  check(
    "same visitor/day returns the IDENTICAL cached order",
    JSON.stringify(second.body && second.body.ranking) === JSON.stringify(ranking1),
  );
  const secondSet = new Set((second.body && second.body.ranking) || []);
  check(
    "cached order also excludes the excluded/out-of-stock products",
    !secondSet.has(EXCLUDED_PID) && !secondSet.has(OOS_PID),
  );

  // --- 5. Arm gating (client side, from the real extension asset) ----------
  console.log("[5] treatment/control gating (extension pure core)");
  const core = loadExtensionCore();
  check("extension core exports shouldApplyRanking", typeof core.shouldApplyRanking === "function");
  const colUrl = `https://${SHOP}/collections/${REF}`;
  check(
    "treatment on unsorted collection page -> ranking applies",
    core.shouldApplyRanking("treatment", { pathname: `/collections/${REF}`, href: colUrl }) === true,
  );
  check(
    "CONTROL visitor -> NO ranking (default order untouched)",
    core.shouldApplyRanking("control", { pathname: `/collections/${REF}`, href: colUrl }) === false,
  );
  check(
    "no-assignment (null variant) -> NO ranking",
    core.shouldApplyRanking(null, { pathname: `/collections/${REF}`, href: colUrl }) === false,
  );
  check(
    "treatment with shopper-picked sort_by -> NO ranking (never fight it)",
    core.shouldApplyRanking("treatment", {
      pathname: `/collections/${REF}`,
      href: colUrl + "?sort_by=price-ascending",
    }) === false,
  );
  check(
    "treatment on non-collection page -> NO ranking",
    core.shouldApplyRanking("treatment", {
      pathname: "/products/some-product",
      href: `https://${SHOP}/products/some-product`,
    }) === false,
  );
  const searchPageUrl = `https://${SHOP}/search?q=${SEARCH_REF}`;
  check(
    "treatment on search results page -> ranking applies (surface=search wired)",
    core.shouldApplyRanking("treatment", {
      pathname: "/search",
      search: `?q=${SEARCH_REF}`,
      href: searchPageUrl,
    }) === true,
  );
  check(
    "control on search results page -> NO ranking",
    core.shouldApplyRanking("control", {
      pathname: "/search",
      search: `?q=${SEARCH_REF}`,
      href: searchPageUrl,
    }) === false,
  );

  // --- 6. Search-surface candidate scoping ---------------------------------
  console.log("[6] search-surface scoping (only Shopify-matched products are candidates)");
  const matchedIds = [P1, P2, OOS_PID].join(",");
  const searchFirst = await getRank(TREAT, {
    surface: "search",
    surfaceRef: SEARCH_REF,
    productIds: matchedIds,
  });
  check("search rank request is 200", searchFirst.status === 200, `status=${searchFirst.status}`);
  check(
    "search ranking scoped to the match set (len=2)",
    !!searchFirst.body &&
      Array.isArray(searchFirst.body.ranking) &&
      searchFirst.body.ranking.length === 2,
    searchFirst.body && searchFirst.body.ranking && searchFirst.body.ranking.length,
  );
  const searchSet = new Set(searchFirst.body && searchFirst.body.ranking);
  check(
    "matched products ranked: P1 (has search stats) AND P2 (zero-history, prior protects it)",
    searchSet.has(P1) && searchSet.has(P2),
  );
  check(
    "matched but OUT-OF-STOCK product excluded (merchant filter applies on search too)",
    !searchSet.has(OOS_PID),
  );
  check(
    "UNMATCHED products NEVER ranked despite shop eligibility/stats (P3, excluded, unmatched)",
    !searchSet.has(P3) && !searchSet.has(EXCLUDED_PID) && !searchSet.has(UNMATCHED_PID),
  );
  const searchStats = await db.product_surface_stats.findMany({
    where: { shop_domain: SHOP, surface: "search", surface_ref: SEARCH_REF },
  });
  check(
    "search-surface stats rollup populated (P1: 5 impressions on the search instance)",
    searchStats.length === 1 &&
      searchStats[0].product_id === P1 &&
      searchStats[0].impressions === 5,
    `rows=${searchStats.length}`,
  );
  const searchSecond = await getRank(TREAT, {
    surface: "search",
    surfaceRef: SEARCH_REF,
    productIds: matchedIds,
  });
  check(
    "search second call cached (drew=false, identical order)",
    !!searchSecond.body &&
      searchSecond.body.drew === false &&
      JSON.stringify(searchSecond.body.ranking) === JSON.stringify(searchFirst.body.ranking),
  );
  const noIds = await getRank(TREAT, { surface: "search", surfaceRef: SEARCH_REF });
  check(
    "search request WITHOUT product_ids fails safe to empty ranking (never whole-shop pool)",
    noIds.status === 200 &&
      !!noIds.body &&
      Array.isArray(noIds.body.ranking) &&
      noIds.body.ranking.length === 0,
  );
  const garbageIds = await getRank(TREAT, {
    surface: "search",
    // A DIFFERENT query (no cached ranking yet) whose match set contains no
    // eligible products: the draw must be empty, never the whole-shop pool.
    surfaceRef: SEARCH_REF + "-no-eligible",
    productIds: "999999,888888",
  });
  check(
    "search request with no ELIGIBLE ids also fails safe to empty ranking",
    garbageIds.status === 200 && !!garbageIds.body && garbageIds.body.ranking.length === 0,
  );

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
      console.log("[cleanup] synthetic shop removed (cascade).");
    } catch (error) {
      console.error("[cleanup] failed:", error instanceof Error ? error.message : error);
    }
    await db.$disconnect();
  });
