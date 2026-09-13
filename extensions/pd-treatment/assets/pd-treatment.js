/**
 * ============================================================================
 * PD TREATMENT — THOMPSON SAMPLING (live scoring wired into the collection
 * surface; daily cached draw served by /api/proxy/rank)
 * ============================================================================
 * Purpose: prove the experiment pipeline end to end — assignment (Prompt 1
 * logic, unchanged) -> different rendering -> different behaviour -> a
 * measurable difference in the attribution query (Prompt 2). The scoring is
 * now the real Thompson Sampling ranking (app/utils/thompson-sampling.ts),
 * drawn once per visitor/surface/UTC-day and applied client-side.
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
 *   3. If (and only if) the visitor is in the treatment arm, fetches the
 *      day's Thompson ranking (/apps/pd/rank -> app /api/proxy/rank) and
 *      re-orders the collection grid client-side to match it. It does NOT
 *      change the collection's saved default order and affects only this
 *      visitor's view. Control visitors and visitors with no active
 *      experiment on the surface get NO reordering: they see the merchant's
 *      default order, untouched.
 *   4. On collection and default search-results pages (/search?q=...), tags
 *      visible product cards from the DOM (no theme edits) and reports real
 *      viewport impressions via the same identity bridge the pixel already
 *      uses (Shopify.analytics.publish). Home, product, and cart pages are
 *      not impression-tracked. Treatment/control assignment and the ranking
 *      application stay collection-only.
 *
 * Failure posture: any error (fetch failed, shop not installed, invalid
 * response) results in NO action — the shopper sees the default order. This
 * script must never break the storefront.
 */
(function () {
  "use strict";

  var COLLECTION_PATH_RE = /\/collections\/([^\/?#]+)/;
  var COOKIE_NAME = "pd_visitor_id";
  var COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year
  var ASSIGN_PATH = "/apps/pd/assign"; // app proxy -> /api/proxy/assign
  var RANK_PATH = "/apps/pd/rank"; // app proxy -> /api/proxy/rank
  // Bounded wait for the shared handle->id map (below) before applying the
  // ranking; on timeout we apply with whatever ids resolved by then.
  var RANK_ID_MAP_TIMEOUT_MS = 3000;
  // Custom event consumed by the web pixel (extensions/pd-web-pixel). Must
  // stay in sync with BRIDGE_EVENT there.
  var BRIDGE_EVENT = "pd:visitor_identified";
  // Set by trackProductImpressions(); flushed on pagehide /
  // visibilitychange=hidden so dwell before navigation is never lost.
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
   * Which impression surface this page is, if any. Ranking application still
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
   * true when the Thompson Sampling ranking should be applied for this page
   * view — treatment-arm visitor on a collection page with NO explicit
   * sort_by. (The placeholder's sort redirect is gone, so a sort_by present
   * now always means the shopper picked it — never fight it.)
   */
  function shouldApplyRanking(variant, locationLike) {
    if (variant !== "treatment") {
      return false; // control / null (no active experiment) -> default order
    }
    if (!parseCollectionHandle(locationLike.pathname)) {
      return false; // not a collection page
    }
    var url = new URL(locationLike.href);
    return !url.searchParams.has("sort_by");
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
    shouldApplyRanking: shouldApplyRanking,
    findCardContainer: findCardContainer,
    RANK_PATH: RANK_PATH,
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

  // Shared with trackProductImpressions(): the batched handle->numeric-id map
  // (ONE same-origin storefront fetch per page) plus a promise resolved when
  // it lands. The ranking applier waits on it (bounded) so card->product
  // mapping uses the SAME canonical numeric ids the impressions and the
  // product_surface_stats rollup are keyed on — never handle strings.
  var handleIdMap = {};
  var handleIdMapReadyResolve = null;
  var handleIdMapReady = new Promise(function (resolve) {
    handleIdMapReadyResolve = resolve;
  });

  function whenHandleIdMapReady(timeoutMs) {
    return Promise.race([
      handleIdMapReady,
      new Promise(function (resolve) {
        setTimeout(function () {
          resolve(handleIdMap);
        }, timeoutMs);
      }),
    ]);
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
      console.log("[PD treatment] could not read visitor cookie", error);
    }
    if (existing) {
      return existing;
    }
    var created = generateUuid();
    try {
      writeVisitorCookie(created);
    } catch (error) {
      console.log("[PD treatment] could not persist visitor cookie", error);
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
        console.log("[PD treatment] assignment request failed; leaving default order", error);
        return null;
      });
  }

  /**
   * Fetch the day's Thompson ranking for this visitor+collection from the
   * app proxy (same-origin; Shopify signs the request server-side). Resolves
   * { ranking, drew, date_utc } or null on any failure — null means "keep
   * the default order".
   */
  function fetchDailyRanking(visitorId, handle) {
    var params = new URLSearchParams({
      visitor_id: visitorId,
      surface: "collection",
      surface_ref: handle,
    });
    var shopDomain = (window.Shopify && window.Shopify.shop) || "";
    if (shopDomain) {
      params.set("shop", shopDomain); // fallback; the proxy also signs `shop`
    }
    return fetch(RANK_PATH + "?" + params.toString(), { method: "GET" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function (error) {
        console.log("[PD treatment] ranking request failed; leaving default order", error);
        return null;
      });
  }

  /**
   * Canonical numeric product id for a card: the impression tracker's tag,
   * else the theme's own data-product-id markup, else the shared batched
   * handle->id map. Null when unresolvable — such cards are NEVER reordered
   * (they keep their default position; no handle strings as ids).
   */
  function cardNumericId(card, handle, idMap) {
    var tagged = card.getAttribute && card.getAttribute("data-pd-product-id");
    if (tagged && /^\d+$/.test(tagged)) return tagged;
    var nested = card.querySelector ? card.querySelector("[data-product-id]") : null;
    if (nested) {
      var markupId = nested.getAttribute("data-product-id");
      if (markupId && /^\d+$/.test(markupId)) return markupId;
    }
    var mapped = idMap[handle];
    return mapped && /^\d+$/.test(mapped) ? mapped : null;
  }

  /**
   * Apply a ranked product_id order to the collection grid. Reorders only
   * cards sharing the reference card's grid parent (never pulls cards across
   * sections). Cards whose id is unresolvable or absent from the ranking
   * keep their default relative position after the ranked block.
   * Returns the number of cards moved (0 = grid untouched).
   */
  function applyRankingToGrid(ranking, idMap) {
    if (!Array.isArray(ranking) || ranking.length === 0) return 0;
    var anchors = document.querySelectorAll("a[href]");
    var seenCards = new Set();
    var entries = []; // { card, id } in DOM order
    for (var i = 0; i < anchors.length; i++) {
      var handle = parseProductHandle(anchors[i].getAttribute("href"));
      if (!handle) continue;
      var card = findCardContainer(anchors[i]);
      if (!card || seenCards.has(card)) continue;
      var id = cardNumericId(card, handle, idMap || {});
      if (!id) continue;
      seenCards.add(card);
      entries.push({ card: card, id: id });
    }
    if (entries.length < 2) return 0;

    var rankIndex = {};
    for (var r = 0; r < ranking.length; r++) {
      var pid = String(ranking[r]);
      if (!(pid in rankIndex)) rankIndex[pid] = r;
    }

    var parent = entries[0].card.parentElement;
    if (!parent) return 0;
    var ranked = entries
      .filter(function (e) {
        return e.card.parentElement === parent && e.id in rankIndex;
      })
      .sort(function (a, b) {
        return rankIndex[a.id] - rankIndex[b.id];
      });
    if (ranked.length < 2) return 0;

    // Insertion anchor: the first grid child AFTER the ranked block's
    // original position that is not itself ranked (null => append at end).
    var rankedSet = new Set(ranked.map(function (e) { return e.card; }));
    var anchor = ranked[0].card.nextSibling;
    while (anchor && rankedSet.has(anchor)) {
      anchor = anchor.nextSibling;
    }

    var frag = document.createDocumentFragment();
    for (var k = 0; k < ranked.length; k++) {
      frag.appendChild(ranked[k].card);
    }
    parent.insertBefore(frag, anchor);
    return ranked.length;
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
        console.log("[PD treatment] published visitor identity to pixel");
      } else {
        console.log("[PD treatment] Shopify.analytics.publish unavailable; pixel will use its sandbox id");
      }
    } catch (error) {
      console.log("[PD treatment] could not publish visitor identity", error);
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
   *      data-pd-product-id — the theme's numeric data-product-id when it
   *      exposes one, otherwise the canonical numeric id resolved by ONE
   *      batched storefront products.json fetch (handle -> id). Cards that
   *      cannot be resolved to a numeric id are SKIPPED (loud warn), never
   *      tagged with the handle string.
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
    // Canonical Shopify product.Json endpoint: one same-origin batched GET per
    // page that maps handle -> numeric product id. Collection pages use
    // /collections/{handle}/products.json; search-results pages use
    // /search.json?q={query}. Removes the per-card network-call fallback and
    // guarantees impressions record the SAME numeric id the events/products
    // tables are keyed on.
    var PRODUCTS_FETCH_LIMIT = 250;

    var taggedIds = new Set();
    var pendingDwell = new Set();
    var impressed = new Set();
    var lastRatio = new WeakMap();
    var queued = [];
    var debounceTimer = null;

    // handle -> numeric product id, built by ONE batched storefront fetch.
    // Empty until the fetch lands; never contains handle strings as values.
    var handleToId = {};
    var handleToIdPromise = null;
    // Cards whose handle was not resolvable from markup when scanned; they wait
    // for the batched fetch (if one is in flight) before being tagged.
    var pendingCards = [];
    // Deduplicate pending entries across re-scans (MutationObserver).
    var pendingHandles = new Set();
    // Handles a completed fetch could not map to a numeric id: skip fast and
    // never re-fetch them every scan.
    var unResolvableHandles = new Set();

    function resolveNumericIdFromMarkup(card) {
      var direct = card.getAttribute && card.getAttribute("data-product-id");
      if (direct && /^\d+$/.test(direct)) return direct;
      var nested = card.querySelector ? card.querySelector("[data-product-id]") : null;
      if (nested) {
        var nestedId = nested.getAttribute("data-product-id");
        if (nestedId && /^\d+$/.test(nestedId)) return nestedId;
      }
      return null;
    }

    /** Batch-resolve handles -> numeric ids from the storefront JSON API (one
     *  GET for the whole page; cached). Returns the handle->id map, or {} on
     *  any failure (callers must then skip + warn, never fall back to handle). */
    function resolveHandleToId(handles) {
      // The API returns at most PRODUCTS_FETCH_LIMIT per page; issue follow-up
      // pages only while a full page came back AND we still have handles to find.
      var unique = Array.from(new Set(handles));
      var map = {};
      var url;
      if (surfaceInfo.surface === "search") {
        url = "/search.json?q=" + encodeURIComponent(surfaceInfo.surfaceRef);
      } else {
        url = "/collections/" + encodeURIComponent(surfaceInfo.surfaceRef) +
              "/products.json?limit=" + PRODUCTS_FETCH_LIMIT;
      }

      async function fetchPage(pageIndex) {
        var sep = url.indexOf("?") >= 0 ? "&" : "?";
        var pageUrl = url + sep + "page=" + pageIndex;
        // Storefront JSON is same-origin; no credentials needed.
        var response = await fetch(pageUrl, { method: "GET" });
        if (!response.ok) {
          throw new Error("HTTP " + response.status + " for " + pageUrl);
        }
        var body = await response.json();
        var products = (body && Array.isArray(body.products)) ? body.products : [];
        for (var i = 0; i < products.length; i++) {
          var p = products[i];
          if (p && typeof p.handle === "string" && /^\d+$/.test(String(p.id))) {
            map[p.handle] = String(p.id);
          }
        }
        return products.length === PRODUCTS_FETCH_LIMIT;
      }

      async function run() {
        // "complete" = the fetch covered every product on this surface, so a
        // missing handle is genuinely unresolvable (not just on an unfetched
        // page). Early break / page cap / network error all mean incomplete,
        // and missing handles get a bounded retry instead of a permanent skip.
        var complete = true;
        try {
          var pageIndex = 1;
          var more = true;
          while (more && pageIndex <= 5) { // hard cap: 5 * 250 = 1250 products
            more = await fetchPage(pageIndex);
            if (!more) break; // natural end of the listing -> complete
            if (pageIndex === 5) { complete = false; break; } // page cap
            if (unique.every(function (h) { return map[h] !== undefined; })) {
              complete = false; // early break: later handles may be on later pages
              break;
            }
            pageIndex++;
          }
        } catch (error) {
          complete = false;
          console.warn(
            "[PD treatment] could not fetch product handle->id map from " +
              url.split("?")[0] + " — " +
              (error instanceof Error ? error.message : String(error)) +
              "; unresolved impressions will be SKIPPED (no handle persisted)."
          );
        }
        handleToId = map;
        handleIdMap = map;
        if (handleIdMapReadyResolve) {
          handleIdMapReadyResolve(map);
          handleIdMapReadyResolve = null;
        }
        handleToIdPromise = null;
        // Tag any cards that had been waiting on this fetch.
        flushPendingCards(complete);
        return map;
      }

      if (handleToIdPromise) return;
      handleToIdPromise = run();
      return handleToIdPromise;
    }

    // Runs when a batched fetch lands. Tags cards that now have a numeric id.
    // A handle the fetch could NOT map is either:
    //   - genuinely unresolvable (fetchComplete) -> warn loudly + remember it
    //     (unResolvableHandles) so it is never re-fetched, impression skipped;
    //   - possibly on an unfetched page (!fetchComplete) -> bounded retry
    //     (max RESOLVE_ATTEMPTS per handle), then treated as unresolvable.
    // In NO case is a handle string persisted as a product id.
    var RESOLVE_ATTEMPTS = 2;

    function flushPendingCards(fetchComplete) {
      var waiting = [];
      var lost = [];
      for (var i = 0; i < pendingCards.length; i++) {
        var entry = pendingCards[i];
        var id = handleToId[entry.handle];
        if (id && entry.card) {
          if (!taggedIds.has(id)) {
            taggedIds.add(id);
            entry.card.setAttribute("data-pd-product-id", id);
            observer.observe(entry.card);
          }
          pendingHandles.delete(entry.handle);
        } else if (id) {
          // Defensive: a card-less entry (findCardContainer returned null).
          pendingHandles.delete(entry.handle);
        } else if (!fetchComplete && (entry.attempts || 0) < RESOLVE_ATTEMPTS) {
          entry.attempts = (entry.attempts || 0) + 1;
          waiting.push(entry);
        } else {
          lost.push(entry);
          unResolvableHandles.add(entry.handle);
          pendingHandles.delete(entry.handle);
        }
      }
      pendingCards = waiting;
      if (lost.length) {
        var missing = lost.map(function (e) { return e.handle; }).join(", ");
        console.warn(
          "[PD treatment] product ids unresolvable by the storefront " +
            "handle->id map: " + missing +
            " — these impressions were NOT recorded (canonical numeric id unknown)."
        );
      }
      if (waiting.length) {
        // Incomplete fetch: retry just the missing handles once more.
        resolveHandleToId(waiting.map(function (e) { return e.handle; }));
      }
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
            "[PD treatment] published product_impressions: " +
              ids.length + " " + JSON.stringify(ids)
          );
        }
      } catch (error) {
        console.log("[PD treatment] could not publish product_impressions", error);
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
      var unresolvedHandles = [];
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var handle = parseProductHandle(link.getAttribute("href") || link.href, window.location.href);
        if (!handle) continue;
        var card = findCardContainer(link);
        // Fast path: the theme already exposes a numeric id in markup.
        var numeric = resolveNumericIdFromMarkup(card);
        if (!numeric && handleToId[handle]) numeric = handleToId[handle];
        if (numeric) {
          if (taggedIds.has(numeric)) continue;
          taggedIds.add(numeric);
          card.setAttribute("data-pd-product-id", numeric);
          observer.observe(card);
        } else if (!unResolvableHandles.has(handle) && !pendingHandles.has(handle)) {
          // No numeric id available yet: defer this card to the batched
          // handle->id fetch. Never tag with the handle — if the fetch can't
          // resolve it either, flushPendingCards warns and the card is skipped.
          pendingHandles.add(handle);
          pendingCards.push({ card: card, handle: handle });
          unresolvedHandles.push(handle);
        }
      }
      if (unresolvedHandles.length) {
        resolveHandleToId(unresolvedHandles);
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
    console.log("[PD treatment] impression tracking failed; continuing", error);
  }

  var handle = parseCollectionHandle(window.location.pathname);
  if (!handle) {
    return; // not a collection page — identity published, nothing else to do
  }

  assign(visitorId, handle).then(function (result) {
    var variant = result && result.variant;
    console.log(
      "[PD treatment] handle=" + handle + " variant=" + (variant || "none") +
      " visitor=" + visitorId
    );
    if (!shouldApplyRanking(variant, window.location)) {
      return; // control / no experiment / shopper-picked sort -> default order
    }
    // Thompson Sampling treatment (replaces the placeholder sort redirect):
    // fetch the day's cached/drawn ranking for this visitor+collection and
    // re-order the grid client-side. Any failure keeps the default order.
    fetchDailyRanking(visitorId, handle)
      .then(function (payload) {
        var ranking = payload && Array.isArray(payload.ranking) ? payload.ranking : null;
        if (!ranking || ranking.length === 0) {
          console.log("[PD treatment] no ranking; leaving default order");
          return null;
        }
        return whenHandleIdMapReady(RANK_ID_MAP_TIMEOUT_MS).then(function (map) {
          var moved = applyRankingToGrid(ranking, map);
          console.log(
            "[PD treatment] Thompson ranking applied: " + moved + " cards" +
            " (date_utc=" + (payload && payload.date_utc ? payload.date_utc : "?") +
            (payload && payload.drew ? ", fresh draw" : ", cached") + ")"
          );
        });
      })
      .catch(function (error) {
        console.log("[PD treatment] ranking application failed; leaving default order", error);
      });
  });
})();