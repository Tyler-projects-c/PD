import {register} from "@shopify/web-pixels-extension";

// PD raw event tracking (Phase 1).
//
// Subscribes to the six standard customer events, attributes each one to a
// persistent visitor id, and POSTs a minimal payload to the app's /api/events
// ingestion endpoint. The endpoint URL is injected through the pixel
// `settings` (set via the webPixelCreate / webPixelUpdate Admin API mutations).
//
// Visitor identity: the pixel POSTs directly to the app backend
// (settings.apiUrl) — a DIFFERENT origin from the storefront — so the
// shop-domain pd_visitor_id cookie can never attach to these requests (cookie
// attachment follows the request target's domain, and a credentialed request
// would in any case be rejected by this endpoint's wildcard CORS). Identity is
// therefore bridged EXPLICITLY: the theme treatment script reads its
// same-origin cookie and publishes it via Shopify's documented custom-event
// bridge (Shopify.analytics.publish("pd:visitor_identified", { visitor_id })
// on the page), which arrives here as event.customData. The bridged id is
// stored in this sandbox's localStorage (which persists across pages,
// including checkout pages where the theme script does not run), so every
// event — collection_viewed through checkout_completed — carries the SAME
// visitor id the theme used for its experiment assignment. The sandbox
// localStorage id is the fallback when the bridge hasn't fired.

const VISITOR_ID_KEY = "pd_visitor_id";

// Shared promise so concurrent events on first load (e.g. page_viewed +
// product_viewed firing together) wait on a single localStorage read/write
// instead of generating competing UUIDs.
let visitorIdPromise = null;

function generateUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback for sandbox contexts without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function getVisitorId(browser) {
  if (!visitorIdPromise) {
    visitorIdPromise = (async () => {
      try {
        const existing = await browser.localStorage.getItem(VISITOR_ID_KEY);
        if (existing) {
          return existing;
        }
      } catch (error) {
        console.log("PD pixel: could not read visitor id", error);
      }
      const created = generateUuid();
      try {
        await browser.localStorage.setItem(VISITOR_ID_KEY, created);
      } catch (error) {
        console.log("PD pixel: could not persist visitor id", error);
      }
      return created;
    })();
  }
  return visitorIdPromise;
}

// Custom event the theme script publishes with the cookie-derived visitor id
// (Shopify analytics.publish → event.customData here).
const BRIDGE_EVENT = "pd:visitor_identified";
// How long events wait for the bridge before falling back to the sandbox id.
// The theme script publishes during page load (deferred app embed), so this
// normally resolves in well under a second; checkout pages, where the theme
// script never runs, always take the full wait and then reuse the id stored
// by earlier pages.
const IDENTITY_WAIT_MS = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identity bridged from the theme on THIS page, plus waiters for events that
// fired before it arrived.
let bridgedVisitorId = null;
const bridgeWaiters = [];

function settleBridgedVisitorId(id) {
  if (bridgedVisitorId) {
    return; // first bridge on a page wins; later pages re-settle a fresh copy
  }
  bridgedVisitorId = id;
  while (bridgeWaiters.length) {
    bridgeWaiters.shift()(id);
  }
}

/**
 * Resolves the visitor id to send: the bridged cookie id if it has arrived
 * (or arrives within IDENTITY_WAIT_MS), otherwise the sandbox localStorage id
 * (persisting a fresh one if needed). Never rejects.
 */
function resolveVisitorId(browser) {
  if (bridgedVisitorId) {
    return Promise.resolve(bridgedVisitorId);
  }
  return new Promise((resolve) => {
    let settled = false;
    bridgeWaiters.push((id) => {
      if (!settled) {
        settled = true;
        resolve(id);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        getVisitorId(browser).then(resolve);
      }
    }, IDENTITY_WAIT_MS);
  });
}

// "gid://shopify/Product/123456" -> "123456"; plain numeric ids pass through.
// Falls back to the raw string so unexpected formats still reach the server
// (which validates and rejects anything unusable).
function extractNumericId(rawId) {
  if (!rawId) {
    return null;
  }
  const match = String(rawId).match(/(\d+)\s*$/);
  return match ? match[1] : String(rawId);
}

// Surface ref for collection experiments is the collection HANDLE parsed from
// the page URL — NOT the numeric collection id. The theme treatment script can
// only see the URL, so both sides must derive the same surface_ref
// independently for the rendering decision and the tracked events to resolve
// to the SAME experiment instance.
function extractCollectionHandle(href) {
  const match = String(href || "").match(/\/collections\/([^\/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

register(({analytics, browser, init, settings}) => {
  const shopDomain = init?.data?.shop?.myshopifyDomain ?? "";
  // Runtime settings (set via webPixelCreate/webPixelUpdate) are delivered on
  // the register context as `settings`. Some runtimes also mirror them on
  // init.data.settings — read both so a missing apiUrl is never silent.
  const apiUrl = settings?.apiUrl ?? init?.data?.settings?.apiUrl;

  console.log(
    `PD pixel: register | shop=${shopDomain} | apiUrl=${apiUrl ?? "(missing)"} | ` +
      `settingsKeys=${JSON.stringify(Object.keys(settings ?? {}))} | ` +
      `initDataKeys=${JSON.stringify(Object.keys(init?.data ?? {}))}`,
  );

  if (!apiUrl) {
    console.log(
      "PD pixel: settings.apiUrl is not configured; dropping events — " +
        "run the Enable tracking flow / auto-resync so the pixel gets its target URL.",
    );
    return;
  }

  // Fire-and-forget: never block or break the storefront on tracking
  // failures. keepalive lets the request survive page transitions, which is
  // essential for checkout_completed (thank-you page).
  //
  // NOTE: deliberately NO credentials:"include" — this request targets the
  // app backend, a different origin from the storefront, so the shop-domain
  // pd_visitor_id cookie never attaches to it (and this endpoint's wildcard
  // CORS would reject a credentialed request outright). Identity travels in
  // the payload instead (see resolveVisitorId / BRIDGE_EVENT).
  const sendEvent = (eventType, timestamp, extra = {}) => {
    resolveVisitorId(browser)
      .then((visitorId) => {
        console.log(`PD pixel: sending ${eventType} -> ${apiUrl}`);
        return fetch(apiUrl, {
          method: "POST",
          body: JSON.stringify({
            event_type: eventType,
            visitor_id: visitorId,
            shop_domain: shopDomain,
            occurred_at: timestamp,
            ...extra,
          }),
          keepalive: true,
        });
      })
      .catch((error) => {
        console.log(`PD pixel: failed to send ${eventType}`, error);
      });
  };

  // Identity bridge from the theme (see module doc). The published payload
  // arrives as event.customData. Persisting it over VISITOR_ID_KEY means
  // later pages — including checkout pages, where the theme script never runs
  // — reuse the SAME id via getVisitorId's localStorage read.
  analytics.subscribe(BRIDGE_EVENT, (event) => {
    const id = event?.customData?.visitor_id;
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      console.log("PD pixel: ignored malformed pd:visitor_identified payload");
      return;
    }
    settleBridgedVisitorId(id);
    browser.localStorage
      .setItem(VISITOR_ID_KEY, id)
      .catch((error) => console.log("PD pixel: could not persist bridged visitor id", error));
    console.log(`PD pixel: bridged visitor identity from theme`);
  });

  analytics.subscribe("page_viewed", (event) => {
    sendEvent("page_viewed", event.timestamp);
  });

  analytics.subscribe("product_viewed", (event) => {
    sendEvent("product_viewed", event.timestamp, {
      product_id: extractNumericId(event.data?.productVariant?.product?.id),
    });
  });

  analytics.subscribe("search_submitted", (event) => {
    // surface_ref is the raw search query: each distinct query is its own
    // experiment instance (the server assigns per surface_ref).
    const query = event.data?.searchResult?.query ?? null;
    sendEvent("search_submitted", event.timestamp, {
      surface: "search",
      surface_ref: query,
    });
  });

  analytics.subscribe("collection_viewed", (event) => {
    // surface_ref is the collection HANDLE from the page URL (see
    // extractCollectionHandle) — must match what the theme treatment script
    // computes so both sides use the same experiment instance.
    sendEvent("collection_viewed", event.timestamp, {
      surface: "collection",
      surface_ref: extractCollectionHandle(event.context?.document?.location?.href),
    });
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    sendEvent("product_added_to_cart", event.timestamp, {
      product_id: extractNumericId(event.data?.cartLine?.merchandise?.product?.id),
    });
  });

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data?.checkout;
    const lineItems = Array.isArray(checkout?.lineItems) ? checkout.lineItems : [];

    sendEvent("checkout_completed", event.timestamp, {
      order_id: extractNumericId(checkout?.order?.id),
      revenue: checkout?.totalPrice?.amount ?? null,
      line_items: lineItems.map((lineItem) => ({
        product_id: extractNumericId(lineItem?.merchandise?.product?.id),
        revenue:
          lineItem?.cost?.totalAmount?.amount ??
          lineItem?.finalLinePrice?.amount ??
          null,
      })),
    });
  });

  console.log("PD pixel: subscriptions registered");
});