import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordComplianceRequest, sanitizeCompliancePayload } from "../utils/compliance.server";

const LOG_PREFIX = "[gdpr:data_request]";

// Canonical webhook topic (matches compliance_requests_topic_check constraint).
const TOPIC = "customers/data_request";

/**
 * customers/data_request (GDPR)
 *
 * Payload per https://shopify.dev/docs/apps/build/privacy-law-compliance:
 *   { shop_id, shop_domain, orders_requested: number[], customer: {id,email,phone},
 *     data_request: { id } }
 *
 * Shopify's model: the app must hand the data it holds about this customer to
 * the STORE OWNER directly — the app does not email the customer. Our app
 * stores NO customer email/phone/customer-id anywhere; the only data that can
 * be tied to a real customer is `events` where order_id is one of the
 * `orders_requested` (a checkout the customer actually placed). Anonymous
 * browsing events (no order link) are keyed by a random visitor UUID that is
 * never connected to a customer identity, so they are not "data about this
 * customer" in the GDPR sense.
 *
 * We log the receipt + what we found to compliance_requests (audit trail) and
 * return 200. HMAC verification is done automatically by authenticate.webhook.
 *
 * PII policy: Shopify's payload includes customer.email/phone, but the audit
 * row persists an allow-listed, PII-free projection of the payload (see
 * sanitizeCompliancePayload) — contact info is omitted entirely, never stored.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const p = (payload ?? {}) as Record<string, any>;

  try {
    const ordersRequested = Array.isArray(p.orders_requested)
      ? p.orders_requested.map(String)
      : [];

    // Find the only customer-identifiable data we hold: events linked to the
    // requested orders (order_id stored as string).
    const matched = ordersRequested.length
      ? await db.events.findMany({
          where: { shop_domain: shop, order_id: { in: ordersRequested } },
          select: { event_id: true, event_type: true, product_id: true, order_id: true, revenue: true, occurred_at: true },
        })
      : [];

    const customerId = (p.customer as Record<string, unknown> | undefined)?.id ?? null;

    await recordComplianceRequest({
      shopDomain: shop,
      topic: TOPIC,
      // Allow-listed projection — customer.email/phone from the raw payload are
      // NOT persisted (see sanitizeCompliancePayload for the keep/drop policy).
      payload: sanitizeCompliancePayload({
        shopDomain: shop,
        customer: p.customer,
        orders: p.orders_requested,
        orderField: "orders_requested",
        dataRequestId: p.data_request?.id,
        matchedEventIds: matched.map((e) => e.event_id),
      }),
      actionTaken:
        `Data request received. Reported ${matched.length} order-linked event row(s) for customer_id=${customerId ?? "-"} ` +
        `(orders: [${ordersRequested.join(",") || "-"}]). No PII fields persisted in this record. ` +
        `Matched event ids: ${matched.map((e) => e.event_id).join(",") || "none"}. ` +
        `Per Shopify GDPR flow the found data is made available to the store owner directly; the app sends no email to the customer.`,
    });

    console.log(
      `${LOG_PREFIX} ${shop} frameworkTopic=${topic} canonical=${TOPIC} data_request=${p.data_request?.id ?? "-"} matchedEvents=${matched.length}`,
    );

    return new Response();
  } catch (err) {
    console.error(`${LOG_PREFIX} FAILED for ${shop}:`, err);
    throw err;
  }
};