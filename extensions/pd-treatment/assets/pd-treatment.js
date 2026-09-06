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
 *   4. On collection and default search-results pages (/search?q=...), tags
 *      visible product cards from the DOM (no theme edits) and reports real
 *      viewport impressions via the same identity bridge the pixel already
 *      uses (Shopify.analytics.publish). Home, product, and cart pages are
 *      not impression-tracked. Treatment/control assignment and the sort
 *      redirect stay collection-only.
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
  // Set by trackProductImpressions() so a treatment redirect can flush the
  // impression batch before navigating away.
  var impressionFlushNow = null;

  /** "/collections/frontpage?..." -> "frontpage"; null when not a collection page. */
  function parseCollectionHandle(pathname) {
    var match = COLLECTION_PATH_RE.exec(pathname || "");
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Shopify's default search results URL: /search?q=...
   * Returns the trimmed, lowercased query, or null when this is not a search
   * results page / the query is empty. Locale-prefixed paths are not matched.
   */
  function parseSearchQuery(pathname, search) {
    if (!/^\/search\/?$/.test(pathname || "")) {
      return null;
    }
    var query = "";
    try {
      query = new URLSearchParams(search || "").get("q") || "";
    } catch (error) {
      return null;
    }
    query = String(query).trim().toLowerCase();
    return query ? query : null;
  }

  /**
   * Which impression surface this page is, if any. Treatment redirect still
   * uses parseCollectionHandle alone — do not fold that into this helper.
   */
  function resolveSurface(pathname, search) {
    var collectionHandle = parseCollectionHandle(pathname);
    if (collectionHandle) {
      return { surface: "collection", surfaceRef: collectionHandle };
    }
    var searchQuery = parseSearchQuery(pathname, search);
    if (searchQuery) {
      return { surface: "search", surfaceRef: searchQuery };
    }
    return null;
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

  /**
   * Product handle from an <a href>. Matches Shopify's usual shapes:
   *   /products/{handle}
   *   /collections/{col}/products/{handle}
   *   /{locale}/products/{handle}
   * plus absolute shop URLs and query/hash suffixes.
   */
  function parseProductHandle(href, baseHref) {
    if (!href) return null;
    try {
      var url = new URL(href, baseHref || "https://example.invalid");
      var match = url.pathname.match(/\/products\/([^\/]+)\/?$/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Card-container heuristic (easy to retune — this is the one knob):
   *
   * From the product <a>, walk up at most MAX_CARD_DEPTH ancestors.
   * Pick the first node that looks like "one product card", not the grid:
   *   1. Keep walking; if we hit <li>, <figure>, or <article>, use that.
   *      Dawn wraps each card in <li class="grid__item"> — that's the IO
   *      target. Inner .card-wrapper is often display:contents (zero box).
   *   2. Else a class matching card-wrapper / product-card / grid__item /
   *      product-item / card (tokenized, so "discard" does not match).
   *   3. Stop BEFORE climbing into the grid itself: <ul>/<ol>/<table>, or a
   *      class like grid / product-grid / product-list / collection.
   *   4. Fallback: the nearest non-<a> ancestor we passed, else the <a>.
   *
   * Deliberately NO getBoundingClientRect / offsetHeight here: those force
   * layout. This scan is string/tag walks + one querySelectorAll for links.
   */
  var MAX_CARD_DEPTH = 6;
  var CARD_TAG = { LI: 1, FIGURE: 1, ARTICLE: 1 };
  var GRID_TAG = { UL: 1, OL: 1, TABLE: 1 };
  var CARD_CLASS_RE = /(^|[\s_-])(card-wrapper|product-card|productcard|product-item|productitem|grid__item|card)([\s_-]|$)/i;
  var GRID_CLASS_RE = /(^|[\s_-])(grid|product-grid|product-list|collection|products)([\s_-]|$)/i;

  function findCardContainer(anchor) {
    var node = anchor;
    var lastNonAnchor = anchor;
    var classMatch = null;
    for (var depth = 0; depth < MAX_CARD_DEPTH; depth++) {
      var parent = node.parentElement;
      if (!parent) break;
      node = parent;
      var tag = node.tagName;
      if (GRID_TAG[tag]) {
        return classMatch || lastNonAnchor;
      }
      var cls = typeof node.className === "string" ? node.className : "";
      if (cls && GRID_CLASS_RE.test(cls) && !CARD_CLASS_RE.test(cls)) {
        return classMatch || lastNonAnchor;
      }
      if (tag !== "A") lastNonAnchor = node;
      // Prefer <li>/<figure>/<article> even if a inner .card-wrapper matched —
      // Dawn's card-wrapper is often display:contents (zero IO box).
      if (CARD_TAG[tag]) return node;
      if (!classMatch && cls && CARD_CLASS_RE.test(cls)) {
        classMatch = node;
      }
    }
    return classMatch || lastNonAnchor;
  }

  var PD_TREATMENT_CORE = {
    parseCollectionHandle: parseCollectionHandle,
    parseSearchQuery: parseSearchQuery,
    resolveSurface: resolveSurface,
    parseProductHandle: parseProductHandle,
    decideTreatmentRedirect: decideTreatmentRedirect,
    findCardContainer: findCardContainer,
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
  /**
   * Track real product impressions on collection and search-results pages,
   * entirely client-side. No theme-file writes, no Admin API — DOM tagging +
   * IntersectionObserver. Home / product / cart are a no-op (resolveSurface
   * returns null).
   *
   * Pipeline:
   *   1. Scan <a href> whose pathname ends in /products/{handle}.
   *   2. Walk up to a card ancestor (see findCardContainer) and setAttribute
   *      data-pd-product-id (numeric data-product-id if the theme already
   *      exposes one, otherwise the handle).
   *   3. IntersectionObserver threshold 0.5 + 400ms dwell = the impression.
   *   4. Dedup: at most one impression per product id per page view.
   *   5. Batch via Shopify.analytics.publish("pd:product_impressions") on a
   *      800ms debounce after an impression / scroll settle, and immediately
   *      on pagehide / visibilitychange=hidden. Same identity bridge as
   *      pd:visitor_identified — the pixel attaches visitor_id.
   *
   * Performance: one querySelectorAll per scan, no layout reads, IO is async.
   * A debounced MutationObserver (250ms) picks up late-inserted cards without
   * a rAF loop. Safe on 50+ product grids.
   */
  function trackProductImpressions() {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    var surfaceInfo = resolveSurface(window.location.pathname, window.location.search);
    if (!surfaceInfo) {
      return;
    }

    var DWELL_MS = 400;
    var DEBOUNCE_MS = 800;
    var MUTATION_DEBOUNCE_MS = 250;
    var IMPRESSION_EVENT = "pd:product_impressions";

    var taggedIds = new Set();
    var pendingDwell = new Set();
    var impressed = new Set();
    var lastRatio = new WeakMap();
    var queued = [];
    var debounceTimer = null;

    function resolveProductId(card, handle) {
      var direct = card.getAttribute && card.getAttribute("data-product-id");
      if (direct && /^\d+$/.test(direct)) return direct;
      var nested = card.querySelector ? card.querySelector("[data-product-id]") : null;
      if (nested) {
        var nestedId = nested.getAttribute("data-product-id");
        if (nestedId && /^\d+$/.test(nestedId)) return nestedId;
      }
      return handle;
    }

    function publishBatch(ids) {
      if (!ids.length) return;
      try {
        var analytics = window.Shopify && window.Shopify.analytics;
        if (analytics && typeof analytics.publish === "function") {
          analytics.publish(IMPRESSION_EVENT, {
            surface: surfaceInfo.surface,
            surface_ref: surfaceInfo.surfaceRef,
            product_ids: ids,
          });
          console.log(
            "[PD treatment PLACEHOLDER] published product_impressions: " +
              ids.length + " " + JSON.stringify(ids)
          );
        }
      } catch (error) {
        console.log("[PD treatment PLACEHOLDER] could not publish product_impressions", error);
      }
    }

    function flushNow() {
      if (!queued.length) return;
      var ids = queued;
      queued = [];
      publishBatch(ids);
    }
    impressionFlushNow = flushNow;

    function scheduleFlush() {
      if (!queued.length) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushNow, DEBOUNCE_MS);
    }

    function recordImpression(productId) {
      if (impressed.has(productId)) return;
      impressed.add(productId);
      queued.push(productId);
      scheduleFlush();
    }

    function handleIntersect(entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var card = entry.target;
        var productId = card.getAttribute("data-pd-product-id");
        if (!productId) continue;
        lastRatio.set(card, entry.intersectionRatio);
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
        if (impressed.has(productId) || pendingDwell.has(productId)) continue;
        pendingDwell.add(productId);
        setTimeout(function (watchedCard, watchedId) {
          return function () {
            pendingDwell.delete(watchedId);
            if (impressed.has(watchedId)) return;
            if (!document.body.contains(watchedCard)) return;
            var ratio = lastRatio.get(watchedCard) || 0;
            if (ratio < 0.5) return;
            recordImpression(watchedId);
          };
        }(card, productId), DWELL_MS);
      }
    }

    var observer = new IntersectionObserver(handleIntersect, { threshold: 0.5 });

    function scanAndObserve() {
      var links = document.querySelectorAll('a[href*="/products/"]');
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var handle = parseProductHandle(link.getAttribute("href") || link.href, window.location.href);
        if (!handle) continue;
        var card = findCardContainer(link);
        var productId = resolveProductId(card, handle);
        if (taggedIds.has(productId)) continue;
        taggedIds.add(productId);
        card.setAttribute("data-pd-product-id", productId);
        observer.observe(card);
      }
    }

    scanAndObserve();

    var mutationTimer = null;
    if (typeof MutationObserver !== "undefined" && document.body) {
      var mutations = new MutationObserver(function () {
        clearTimeout(mutationTimer);
        mutationTimer = setTimeout(scanAndObserve, MUTATION_DEBOUNCE_MS);
      });
      mutations.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener("scroll", scheduleFlush, { passive: true });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        clearTimeout(debounceTimer);
        flushNow();
      }
    });
    window.addEventListener("pagehide", function () {
      clearTimeout(debounceTimer);
      flushNow();
    });
  }

  var visitorId = getOrCreateVisitorId();
  publishVisitorIdentity(visitorId);

  // Product-impression tracking (Part 2) — scan the DOM for product cards and
  // report which ones the shopper actually SAW (via IntersectionObserver).
  // Isolated so a scan error can never block assignment / identity.
  try {
    trackProductImpressions();
  } catch (error) {
    console.log("[PD treatment PLACEHOLDER] impression tracking failed; continuing", error);
  }

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
      // Flush any impressions already dwelled before navigating away, so a
      // treatment visitor's first view still records seen products.
      try {
        if (impressionFlushNow) impressionFlushNow();
      } catch (error) {
        console.log("[PD treatment PLACEHOLDER] flush before redirect failed", error);
      }
      console.log("[PD treatment PLACEHOLDER] redirecting to " + redirectUrl);
      window.location.replace(redirectUrl);
    }
  });
})();