/**
 * ============================================================================
 * PD TREATMENT — PLACEHOLDER (pipeline proof, NOT the real scoring algorithm)
 * ============================================================================
 * Purpose: prove the experiment pipeline end to end — assignment (Prompt 1
 * logic, unchanged) -> different rendering -> different behaviour -> a
 * measurable difference in the attribution query (Prompt 2). This is NOT the
 * real Bayesian/Thompson ranking; it will be replaced wholesale by the real
 * scoring algorithm once the plumbing is proven.
 *
 * What it does, on every page (app embed block, see blocks/pd_treatment_embed.liquid):
 *   1. Ensures a first-party visitor identity cookie (pd_visitor_id) exists on
 *      the shop domain and PUBLISHES it to the web pixel via Shopify's
 *      documented custom-event bridge (Shopify.analytics.publish). The pixel
 *      POSTs directly to the app backend — a different origin — so this
 *      explicit hand-off is the only way the pixel can send the SAME visitor
 *      id the assignment decision used (cookies on the shop domain never
 *      attach to the pixel's cross-origin requests).
 *   2. On a collection page, asks the app (same-origin via the app proxy,
 *      /apps/pd/assign -> app /api/proxy/assign) which arm the visitor is in
 *      for that collection. This uses the SAME assignVisitorToExperiment()
 *      logic as event tracking — no new assignment mechanism, and the sticky
 *      per-(visitor, surface, surface_ref) draw is shared by both sides.
 *   3. If (and only if) the visitor is in the treatment arm, redirects to the
 *      same URL with ?sort_by=created-descending — Shopify's native per-request
 *      sort override ("most recently created product first"). It does NOT
 *      change the collection's saved default order and affects only this
 *      visitor's request. Control visitors and visitors with no active
 *      experiment on the surface get NO redirect: they see the merchant's
 *      default order, untouched.
 *
 * Failure posture: any error (fetch failed, shop not installed, invalid
 * response) results in NO action — the shopper sees the default order. This
 * script must never break the storefront.
 */
(function () {
  "use strict";

  var COLLECTION_PATH_RE = /\/collections\/([^\/?#]+)/;
  var TREATMENT_SORT_VALUE = "created-descending";
  var COOKIE_NAME = "pd_visitor_id";
  var COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year
  var ASSIGN_PATH = "/apps/pd/assign"; // app proxy -> /api/proxy/assign
  // Custom event consumed by the web pixel (extensions/pd-web-pixel). Must
  // stay in sync with BRIDGE_EVENT there.
  var BRIDGE_EVENT = "pd:visitor_identified";

  /** "/collections/frontpage?..." -> "frontpage"; null when not a collection page. */
  function parseCollectionHandle(pathname) {
    var match = COLLECTION_PATH_RE.exec(pathname || "");
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Pure decision function (also exercised by the Node verification harness):
   * returns the redirect URL for a treatment visitor on an as-yet-unsorted
   * collection page, or null to leave the page (default order) alone.
   */
  function decideTreatmentRedirect(variant, locationLike) {
    if (variant !== "treatment") {
      return null; // control / null (no active experiment) -> default order
    }
    if (!parseCollectionHandle(locationLike.pathname)) {
      return null; // not a collection page
    }
    var url = new URL(locationLike.href);
    if (url.searchParams.has("sort_by")) {
      // Already explicitly sorted (our own redirect, or the shopper picked a
      // sort themselves) — never fight it, and this is what prevents loops.
      return null;
    }
    url.searchParams.set("sort_by", TREATMENT_SORT_VALUE);
    return url.toString();
  }

  var PD_TREATMENT_CORE = {
    parseCollectionHandle: parseCollectionHandle,
    decideTreatmentRedirect: decideTreatmentRedirect,
    TREATMENT_SORT_VALUE: TREATMENT_SORT_VALUE,
  };

  // Node verification harness: expose the pure core without running DOM code.
  if (typeof window === "undefined" && typeof module !== "undefined" && module.exports) {
    module.exports = PD_TREATMENT_CORE;
    return;
  }

  function generateUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
      var random = (Math.random() * 16) | 0;
      return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
    });
  }

  function readVisitorCookie() {
    var match = new RegExp("(?:^|;\\s*)" + COOKIE_NAME + "=([^;\\s]+)").exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeVisitorCookie(id) {
    document.cookie =
      COOKIE_NAME + "=" + encodeURIComponent(id) +
      "; Max-Age=" + COOKIE_MAX_AGE_SECONDS +
      "; Path=/; SameSite=Lax; Secure";
  }

  function getOrCreateVisitorId() {
    var existing = null;
    try {
      existing = readVisitorCookie();
    } catch (error) {
      console.log("[PD treatment PLACEHOLDER] could not read visitor cookie", error);
    }
    if (existing) {
      return existing;
    }
    var created = generateUuid();
    try {
      writeVisitorCookie(created);
    } catch (error) {
      console.log("[PD treatment PLACEHOLDER] could not persist visitor cookie", error);
    }
    return created;
  }

  function assign(visitorId, handle) {
    var params = new URLSearchParams({
      visitor_id: visitorId,
      surface: "collection",
      surface_ref: handle,
    });
    var shopDomain = (window.Shopify && window.Shopify.shop) || "";
    if (shopDomain) {
      params.set("shop_domain", shopDomain); // fallback; the app proxy also sends X-Shopify-Shop-Domain
    }
    return fetch(ASSIGN_PATH + "?" + params.toString(), { method: "GET" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function (error) {
        console.log("[PD treatment PLACEHOLDER] assignment request failed; leaving default order", error);
        return null;
      });
  }

  /**
   * Hands the cookie-derived visitor id to the web pixel over Shopify's
   * custom-event bridge: Shopify.analytics.publish(event, data) on the page
   * arrives in the pixel as event.customData. Runs on EVERY page (before the
   * collection-page early return) so product/cart pages feed the pixel too.
   */
  function publishVisitorIdentity(visitorId) {
    try {
      var analytics = window.Shopify && window.Shopify.analytics;
      if (analytics && typeof analytics.publish === "function") {
        analytics.publish(BRIDGE_EVENT, { visitor_id: visitorId });
        console.log("[PD treatment PLACEHOLDER] published visitor identity to pixel");
      } else {
        console.log("[PD treatment PLACEHOLDER] Shopify.analytics.publish unavailable; pixel will use its sandbox id");
      }
    } catch (error) {
      console.log("[PD treatment PLACEHOLDER] could not publish visitor identity", error);
    }
  }

  var visitorId = getOrCreateVisitorId();
  publishVisitorIdentity(visitorId);

  var handle = parseCollectionHandle(window.location.pathname);
  if (!handle) {
    return; // not a collection page — identity published, nothing else to do
  }

  assign(visitorId, handle).then(function (result) {
    var variant = result && result.variant;
    console.log(
      "[PD treatment PLACEHOLDER] handle=" + handle + " variant=" + (variant || "none") +
      " visitor=" + visitorId
    );
    var redirectUrl = decideTreatmentRedirect(variant, window.location);
    if (redirectUrl) {
      console.log("[PD treatment PLACEHOLDER] redirecting to " + redirectUrl);
      window.location.replace(redirectUrl);
    }
  });
})();