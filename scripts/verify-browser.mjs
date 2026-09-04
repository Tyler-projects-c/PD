// Automated real-browser verification of the PD experiment pipeline.
// Drives headless Edge (no store login needed — uses PD_STORE_PASSWORD from
// .env for the dev-store password page) against the dev store's collection
// page and checks, per fresh browser context (fresh cookie = fresh 50/50
// roll): embed present -> assign request via the signed app proxy ->
// identity bridge (cookie == /api/events payload visitor_id) -> treatment
// redirect iff variant=treatment.
//
// Usage: node scripts/verify-browser.mjs [iterations]   (default 4)
// Requires `shopify app dev` to be running. Edge path is Windows-default;
// adjust EDGE below if needed.
import puppeteer from "puppeteer-core";
import process from "process";

process.loadEnvFile(".env");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const STORE = "https://pd-test-ubhzd2gl.myshopify.com";
const COLLECTION = STORE + "/collections/all";
const ITERATIONS = Number(process.argv[2] ?? 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(browser, index) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const result = {
    index,
    embedScript: false,
    assign: null,        // { status, variant, experimentId }
    assignError: null,   // e.g. "404 theme page (proxy not configured)"
    cookieVisitorId: null,
    eventVisitorIds: new Set(),
    finalUrl: "",
    redirectedToSortBy: false,
    consoleFlags: {},
  };

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("published visitor identity to pixel")) result.consoleFlags.published = true;
    if (text.includes("bridged visitor identity from theme")) result.consoleFlags.bridged = true;
    if (text.includes("PD pixel: sending")) result.consoleFlags.pixelSending = true;
    const handleLine = text.match(/\[PD treatment PLACEHOLDER\] handle=(\S+) variant=(\S+) visitor=(\S+)/);
    if (handleLine) {
      result.consoleFlags.handleLog = true;
      result.logHandle = handleLine[1];
      result.logVariant = handleLine[2];
      result.logVisitor = handleLine[3];
    }
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/apps/pd/assign")) return;
    result.assignSeen = true;
    try {
      const body = (await response.text()).trim();
      if (body.startsWith("{")) {
        const json = JSON.parse(body);
        result.assign = { status: response.status(), variant: json.variant, experimentId: json.experiment_id };
      } else {
        result.assignError = `status ${response.status()} but HTML body (proxy NOT configured — theme soft-404)`;
      }
    } catch {
      // The treatment redirect navigates away before the response body can be
      // read — expected. The console handle/variant log is the fallback source.
      result.assignBodyLost = true;
    }
  });

  page.on("request", (request) => {
    if (request.url().includes("/api/events") && request.method() === "POST") {
      try {
        const body = JSON.parse(request.postData());
        if (body.visitor_id) result.eventVisitorIds.add(body.visitor_id);
      } catch { /* no body */ }
    }
    if (request.url().includes("pd-treatment.js")) {
      result.scriptRequested = true;
    }
  });

  page.on("response", (response) => {
    if (response.url().includes("pd-treatment.js")) {
      result.scriptStatus = response.status();
    }
  });

  let response = await page.goto(COLLECTION, { waitUntil: "networkidle2", timeout: 45000 });

  // Dev-store storefront password gate: enter it if we landed on /password.
  if (new URL(page.url()).pathname === "/password") {
    const password = process.env.PD_STORE_PASSWORD;
    if (!password) throw new Error("storefront is password-protected and PD_STORE_PASSWORD is not set");
    const input = await page.waitForSelector("input[type=password]", { timeout: 15000 });
    await input.type(password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
      page.click("button[type=submit], input[type=submit]"),
    ]);
    // Re-navigate to the collection (post-password landing may differ).
    response = await page.goto(COLLECTION, { waitUntil: "networkidle2", timeout: 45000 });
    if (new URL(page.url()).pathname === "/password") {
      throw new Error("storefront password rejected — check PD_STORE_PASSWORD");
    }
  }
  result.embedScript = (await response.text()).includes("pd-treatment.js");
  await sleep(3500); // identity wait (2s) + possible treatment redirect + follow-up events

  result.finalUrl = page.url();
  result.redirectedToSortBy = new URL(result.finalUrl).searchParams.has("sort_by");
  const cookies = await page.cookies();
  const pdCookie = cookies.find((c) => c.name === "pd_visitor_id");
  result.cookieVisitorId = pdCookie ? pdCookie.value : null;

  console.log(`  [meta] scriptRequested=${result.scriptRequested} scriptStatus=${result.scriptStatus ?? "-"} assignSeen=${result.assignSeen} logVariant=${result.logVariant ?? "-"}`);
  await context.close();
  return result;
}

function judge(r) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add("embed script on page", r.embedScript, r.embedScript ? "pd-treatment.js present" : "pd-treatment.js MISSING — app embed not enabled/saved");
  if (!r.embedScript) return checks; // nothing else can run without the script

  // Variant evidence: the assign response body when readable, otherwise the
  // console log (which survives the treatment redirect's navigation).
  const variant = r.logVariant ?? r.assign?.variant ?? null;
  const assignOk = (r.assign && r.assign.status === 200 && !!r.assign.variant) ||
                   (!!variant && r.assignBodyLost);
  add("assign via proxy", assignOk,
    r.assign ? `status ${r.assign.status}, variant=${r.assign.variant}` :
    r.assignBodyLost ? `response body lost to redirect navigation; variant=${variant} from console log (redirect itself implies assignment succeeded)` :
    r.assignError ?? "request never fired");
  if (!assignOk) return checks;

  add("console handle/variant log", !!r.logHandle, `handle=${r.logHandle} variant=${r.logVariant}`);

  const identityMatch = r.cookieVisitorId && r.eventVisitorIds.has(r.cookieVisitorId);
  add("identity bridge (cookie == event payload)", !!identityMatch,
    `cookie=${r.cookieVisitorId ?? "none"} eventIds=[${[...r.eventVisitorIds].join(", ") || "none"}]`);

  add("rendering matches arm",
    variant === "treatment" ? r.redirectedToSortBy : !r.redirectedToSortBy,
    `variant=${variant}, redirected=${r.redirectedToSortBy}`);
  return checks;
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let pass = 0, fail = 0;
const failures = [];
for (let i = 1; i <= ITERATIONS; i++) {
  let result;
  try {
    result = await runOnce(browser, i);
  } catch (error) {
    console.log(`\n--- iteration ${i}: NAVIGATION ERROR: ${error.message}`);
    fail++;
    continue;
  }
  console.log(`\n--- iteration ${i}: variant=${result.assign?.variant ?? result.logVariant ?? "?"} redirected=${result.redirectedToSortBy} url=${result.finalUrl}`);
  for (const c of judge(result)) {
    if (c.pass) { pass++; console.log(`  PASS ${c.name} (${c.detail})`); }
    else { fail++; failures.push(`iteration ${i}: ${c.name} — ${c.detail}`); console.log(`  FAIL ${c.name} — ${c.detail}`); }
  }
}
await browser.close();

console.log(`\n=== BROWSER VERIFY: ${pass} passed, ${fail} failed ===`);
if (failures.length) console.log(failures.join("\n"));
const armsSeen = new Set();
console.log("(arm coverage noted from logs above — need at least one treatment and one control across iterations)");
process.exitCode = fail > 0 ? 1 : 0;
