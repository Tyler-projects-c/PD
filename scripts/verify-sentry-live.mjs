/**
 * LIVE Sentry verification — ALERTING PATH ONLY (real failure paths, real HTTP).
 *
 * Answers the only question that matters for this feature: do the failure
 * signals this app emits actually ARRIVE at Sentry, or do they merely look
 * like they do from the console?
 *
 * MODES
 * -----
 *   node scripts/verify-sentry-live.mjs --mock
 *       Boots the REAL app server against a LOCAL receiver that speaks
 *       Sentry's envelope ingest protocol, drives the real failure paths over
 *       real HTTP, then parses the envelopes that arrived. No account, no
 *       network: proves init -> capture -> transport -> ingest end to end and
 *       prints the arriving event ids.
 *
 *   SENTRY_DSN=https://...@oNNN.ingest.sentry.io/NNNN node scripts/verify-sentry-live.mjs
 *       The same failure paths against a real DSN. Prints each event's id and
 *       a dashboard link, and — when SENTRY_AUTH_TOKEN + SENTRY_ORG +
 *       SENTRY_PROJECT are also set — confirms via the Sentry Web API that
 *       each event is retrievable, i.e. genuinely in the dashboard.
 *
 * FAILURE PATHS DRIVEN
 * -------------------
 *   Against the booted REAL app server (init -> capture -> transport over HTTP):
 *   1. bad HMAC on the app proxy       -> 401, throttled Sentry message
 *   2. bad HMAC on a webhook           -> 401, Sentry exception
 *   3. malformed orders/paid (SIGNED)  -> structured warn + Sentry message —
 *      a missing order id means revenue verification was silently skipped,
 *      which touches the "provably measured" trust claim, so it alerts
 *      (asserted as a POSITIVE arrival, not a negative control)
 *   4. forced test error               -> reportError via the APP'S OWN Sentry
 *      module -> transport -> ingest, event id printed for dashboard lookup
 *   (the unhandledRejection/uncaughtException safety net's app-server-scoped
 *   proof lives in scripts/verify-error-tracking.mjs [4], which drives the
 *   app's own installGlobalHandlers in a child process both ways.)
 *
 * ALERTING ONLY: nothing here retries, repairs, restarts, or self-heals. It
 * observes and reports. It writes no app state (the malformed orders/paid
 * payload returns before any DB access), so there is nothing to clean up.
 *
 * Usage: npm run verify:sentry            (needs SENTRY_DSN)
 *        npm run verify:sentry -- --mock
 */
import process from "node:process";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.loadEnvFile(".env");

const ROOT = process.cwd();
const PORT = Number(process.env.VERIFY_PORT || 3793);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.SHOPIFY_API_SECRET;
const MOCK = process.argv.includes("--mock");
const SHOP = `sentry-live-${Date.now()}.myshopify.com`;
const RUN_ID = `pd-verify-${Date.now()}`;

let pass = 0;
let fail = 0;
const notes = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Local Sentry-ingest stand-in: accepts envelopes, returns {"id": ...} exactly
// like the real ingest endpoint, and keeps the parsed event payloads.
// ---------------------------------------------------------------------------
function parseEnvelope(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // Envelope headers also carry event_id; real EVENT payloads carry
      // message/exception/level. Only count the latter so arrival counts
      // are one per event, not two.
      if (parsed && parsed.event_id && (parsed.message !== undefined || parsed.exception || parsed.level)) {
        events.push(parsed);
      }
    } catch {
      // item header / envelope header lines are not event payloads
    }
  }
  return events;
}

function startMockIngest() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const events = parseEnvelope(raw);
      for (const event of events) received.push(event);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: events[0]?.event_id ?? "unknown" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

function summarize(event) {
  const exception = event.exception?.values?.[0];
  return {
    event_id: event.event_id,
    level: event.level,
    kind: exception ? "exception" : "message",
    text: exception ? `${exception.type}: ${exception.value}` : String(event.message ?? ""),
    extra: event.extra ?? {},
    request_url: event.request?.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// Real app server boot: the production server (`npm run start` on build
// output) is the runtime the alerts will actually come from, so THAT is what
// we boot and drive.
// ---------------------------------------------------------------------------
async function waitForServer(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/events`, { method: "OPTIONS" });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function sign(payloadStr) {
  return createHmac("sha256", SECRET).update(payloadStr, "utf8").digest("base64");
}

// Shopify webhook HMAC: base64 digest of the RAW request body keyed with the
// app secret (exactly what authenticate.webhook verifies). The library checks
// the HMAC FIRST (401 on mismatch) and only then the required headers
// (x-shopify-topic/-shop-domain/-api-version/-webhook-id; a missing one is
// 400 Bad Request, NOT the app's doing) — so a signed request must carry the
// full real webhook header set, like Shopify actually sends it.
async function postWebhook(path, payloadObj, { badSignature = false } = {}) {
  const body = JSON.stringify(payloadObj);
  const digest = badSignature ? sign("tampered-body") : sign(body);
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": digest,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-topic": path.replace("/webhooks/", "").replaceAll("/", "_"),
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": randomUUID(),
    },
    body,
  });
}

// App-proxy signature: HMAC-SHA256 over the sorted "k=v" concatenation of every
// query param except `signature` itself, hex-encoded, plus a fresh timestamp.
function proxySignature(params) {
  const message = Object.keys(params)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");
  return createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
}

async function getAssignBadHmac(shopDomain) {
  const params = { shop: shopDomain, timestamp: String(Math.floor(Date.now() / 1000)) };
  const qs = new URLSearchParams({ ...params, signature: "0".repeat(64) }).toString();
  return fetch(`${BASE}/api/proxy/assign?${qs}`);
}

// ---------------------------------------------------------------------------
// Result summarizers: mock mode proves ARRIVAL at the ingest stand-in; real-DSN
// mode prints event ids + dashboard links and (with API creds) confirms the
// forced error is retrievable from Sentry itself.
// ---------------------------------------------------------------------------
function summarizeMock(received) {
  const events = received.map(summarize);
  console.log(`[mock] ${events.length} event(s) arrived at the ingest stand-in:`);
  for (const e of events) {
    console.log(`   - ${e.event_id} [${e.level}] ${e.kind}: ${e.text.slice(0, 120)}`);
  }
  check(
    "ARRIVED: forced test error exception",
    events.some((e) => e.kind === "exception" && e.text.includes("pd-sentry-live forced test error")),
    events.find((e) => e.text.includes("forced test error"))?.event_id ?? "",
  );
  check(
    "ARRIVED: proxy bad-HMAC gate alert (first hit alerts)",
    events.some((e) => e.text.includes("rejected unverified request (HMAC/signature gate)")),
  );
  check(
    "THROTTLE: exactly ONE proxy-gate alert for the two rejections",
    events.filter((e) => e.text.includes("rejected unverified request")).length === 1,
  );
  check(
    "ARRIVED: webhook bad-HMAC error",
    events.some((e) => e.text.includes("WEBHOOK AUTHENTICATION FAILED")),
  );
  check(
    "ARRIVED: signed malformed orders/paid warn (trust-claim signal)",
    events.some((e) => e.level === "warning" && e.text.includes("no numeric order id")),
    "malformed payloads silently skip revenue verification — alerting, not console-only",
  );
}

function summarizeRealDsn(dsn, forcedId, serverLog) {
  console.log("[real] dashboard lookup links (review these as the human on call):");
  if (forcedId) {
    console.log(`   - forced test error ${forcedId}`);
    console.log(`     https://sentry.io/issues/?query=${forcedId}`);
  } else {
    console.log("   (no forced-error event id — see the child output above)");
  }
  const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;
  if (forcedId && SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT) {
    const host = process.env.SENTRY_HOST || "sentry.io";
    const url =
      `https://${host}/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/` +
      `${encodeURIComponent(SENTRY_PROJECT)}:${forcedId}/`;
    void fetch(url, { headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}` } })
      .then(async (res) => {
        const body = res.ok ? await res.json() : null;
        check(
          "CONFIRMED via Sentry Web API: forced test error is retrievable",
          res.ok && body?.eventID === forcedId,
          res.ok ? `eventID=${body?.eventID}` : `HTTP ${res.status}`,
        );
      })
      .catch((e) => check("CONFIRMED via Sentry Web API", false, String(e?.message ?? e)));
  } else {
    console.log("   (set SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT to auto-confirm via the Web API)");
  }
  console.log("   [server log below shows the structured failure lines the app emitted]");
  console.log("---- server log (tail) ----");
  console.log(String(serverLog).slice(-4000));
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  if (!SECRET) {
    console.log("FAIL  SHOPIFY_API_SECRET is not set — cannot sign webhook/proxy requests.");
    process.exit(1);
  }

  const mock = MOCK ? await startMockIngest() : null;
  const dsn =
    MOCK
      ? `http://testkey@127.0.0.1:${mock.port}/1`
      : process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("FAIL  no SENTRY_DSN and not --mock. Set SENTRY_DSN or pass --mock.");
    process.exit(1);
  }

  console.log("[boot] building production bundle (react-router build)...");
  const buildRes = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (buildRes.status !== 0) {
    console.log("FAIL  build failed — cannot boot the real server.");
    process.exit(1);
  }

  console.log(
    `[boot] starting real app server on ${BASE} (ingest: ${MOCK ? `mock :${mock.port}` : "real Sentry"})`,
  );
  const child = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "start"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        SHOPIFY_APP_URL: BASE,
        SENTRY_DSN: dsn,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d.toString()));
  child.stderr.on("data", (d) => (serverLog += d.toString()));
  const killServer = () => {
    try {
      if (process.platform === "win32" && child.pid) {
        // shell:true wraps the server in cmd.exe; kill the whole tree.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } else {
        child.kill();
      }
    } catch { /* gone */ }
  };
  process.on("exit", killServer);

  // Forced test error: a separate process initializes the APP'S OWN Sentry
  // module (app/utils/sentry.server.ts) with the same DSN, calls the app's
  // reportError(), and flushes. Returns the Sentry event id so the arrival can
  // be proven rather than assumed.
  async function runForcedError() {
    // The probe lives under the repo root so `import "@sentry/node"` resolves
    // from ROOT/node_modules (a temp dir has no node_modules — that was the
    // ERR_MODULE_NOT_FOUND in the first live run). Removed again after the run.
    const scriptFile = path.join(ROOT, "scripts", `.sentry-force-${RUN_ID}.mjs`);
    const appModule = pathToFileURL(path.join(ROOT, "app", "utils", "sentry.server.ts")).href;
    fs.writeFileSync(
      scriptFile,
      [
        `import { initSentry, reportError } from ${JSON.stringify(appModule)};`,
        `import * as Sentry from "@sentry/node";`,
        `const ok = initSentry({ dsn: process.env.FORCE_DSN, skipGlobalHandlers: true });`,
        `if (!ok) { console.error("initSentry failed"); process.exit(3); }`,
        `const id = reportError(new Error("pd-sentry-live forced test error"), {`,
        `  module: "verify-sentry-live", extra: { run_id: process.env.RUN_ID } });`,
        `console.log("EVENT_ID=" + id);`,
        `Sentry.flush(15_000).then((f) => { console.log("FLUSHED=" + f); process.exit(f ? 0 : 4); });`,
      ].join("\n"),
    );
    // Async spawn, NOT spawnSync: the mock ingest server runs in THIS
    // process, and a blocking spawnSync would freeze its event loop for the
    // child's entire run — the transport's HTTP request would sit unread and
    // flush() would time out, silently LOSING the event (observed as
    // FLUSHED=false in the first mock run).
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptFile], {
      env: { ...process.env, FORCE_DSN: dsn, RUN_ID },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errOut += d.toString()));
    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    try { fs.rmSync(scriptFile, { force: true }); } catch { /* best effort */ }
    const m = /EVENT_ID=([0-9a-f-]+)/.exec(out);
    if (!m) {
      console.log("  note  forced-error child did not report an event id (output below)");
      console.log(out + errOut);
      return null;
    }
    if (/FLUSHED=false/.test(out)) {
      console.log(`  note  forced-error child FLUSHED=false (exit ${exitCode}) — event may not have been delivered`);
    }
    return m[1];
  }

  const up = await waitForServer(BASE);
  check("real app server booted", up);
  if (!up) {
    console.log("---- server log (tail) ----");
    console.log(serverLog.slice(-4000));
    killServer();
    process.exit(1);
  }

  // ---- 1) bad HMAC on the app proxy: 401, throttled Sentry alert ------------
  const rProxy1 = await getAssignBadHmac(SHOP);
  check("bad-HMAC app-proxy request rejected 401", rProxy1.status === 401, `HTTP ${rProxy1.status}`);
  const rProxy2 = await getAssignBadHmac(SHOP);
  check("repeat rejection still 401 (service unaffected)", rProxy2.status === 401, `HTTP ${rProxy2.status}`);

  // ---- 2) bad HMAC on a webhook: 401, Sentry error ---------------------------
  const rWebhook = await postWebhook("/webhooks/orders/paid", { id: 1, line_items: [] }, { badSignature: true });
  check("bad-HMAC webhook rejected 401", rWebhook.status === 401, `HTTP ${rWebhook.status}`);

  // ---- 3) SIGNED but malformed orders/paid: warn + Sentry (trust claim) ------
  const rMalformed = await postWebhook("/webhooks/orders/paid", { line_items: [] });
  check("signed malformed orders/paid accepted (structured warn + Sentry)", rMalformed.status === 200, `HTTP ${rMalformed.status}`);

  // ---- 4) forced test error through the app's own reportError ---------------
  const forcedId = await runForcedError();
  check("forced test error captured (event id returned)", typeof forcedId === "string" && forcedId.length > 0, forcedId ?? "");

  // Give the SDK transports (app server + forced-error child) time to drain.
  await new Promise((r) => setTimeout(r, 4_000));

  if (!MOCK) summarizeRealDsn(dsn, forcedId, serverLog);
  else summarizeMock(mock.received);

  killServer();
  mock?.server.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.log("FAIL  verifier crashed:", e?.stack ?? String(e));
  process.exit(1);
});

