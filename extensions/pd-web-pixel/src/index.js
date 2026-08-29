import {register} from "@shopify/web-pixels-extension";

// PD raw event tracking (Phase 1).
//
// Subscribes to the six standard customer events, attributes each one to a
// persistent visitor id (kept in browser.localStorage), and POSTs a minimal
// payload to the app's /api/events ingestion endpoint. The endpoint URL is
// injected through the pixel `settings` (set via the webPixelCreate /
// webPixelUpdate Admin API mutations).

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

register(({analytics, browser, init, settings}) => {
  const shopDomain = init?.data?.shop?.myshopifyDomain ?? "";
  const apiUrl = settings?.apiUrl;

  if (!apiUrl) {
    console.log("PD pixel: settings.apiUrl is not configured; dropping events");
    return;
  }

  // Fire-and-forget: never block or break the storefront on tracking
  // failures. keepalive lets the request survive page transitions, which is
  // essential for checkout_completed (thank-you page).
  const sendEvent = (eventType, timestamp, extra = {}) => {
    getVisitorId(browser)
      .then((visitorId) =>
        fetch(apiUrl, {
          method: "POST",
          body: JSON.stringify({
            event_type: eventType,
            visitor_id: visitorId,
            shop_domain: shopDomain,
            occurred_at: timestamp,
            ...extra,
          }),
          keepalive: true,
        }),
      )
      .catch((error) => {
        console.log(`PD pixel: failed to send ${eventType}`, error);
      });
  };

  analytics.subscribe("page_viewed", (event) => {
    sendEvent("page_viewed", event.timestamp);
  });

  analytics.subscribe("product_viewed", (event) => {
    sendEvent("product_viewed", event.timestamp, {
      product_id: extractNumericId(event.data?.productVariant?.product?.id),
    });
  });

  analytics.subscribe("search_submitted", (event) => {
    sendEvent("search_submitted", event.timestamp);
  });

  analytics.subscribe("collection_viewed", (event) => {
    sendEvent("collection_viewed", event.timestamp);
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
});