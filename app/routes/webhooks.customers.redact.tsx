import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordComplianceRequest, sanitizeCompliancePayload } from "../utils/compliance.server";

const LOG_PREFIX = "[gdpr:customers_redact]";

// Canonical webhook topic (matches compliance_requests_topic_check constraint).
const TOPIC = "customers/redact";

/**
 * customers/redact (GDPR)
 *
 * Payload per https://shopify.dev/docs/apps/build/privacy-law-compliance:
 *   { shop_id, shop_domain, customer: {id,email,phone}, orders_to_redact: number[] }
 *
 * The only data PD stores that is identifiably tied to a real customer is
 * `events` rows whose order_id matches an order the customer placed
 * (checkout_completed etc.). Anonymous browsing events are keyed by a random
 * visitor UUID that is never connected to a Shopify customer identity, so they
 * are not "identifiably tied" to this customer and are NOT redacted here.
 *
 * We delete the order-linked events, record the action in compliance_requests
 * (audit trail), and return 200. HMAC verification is automatic.
 *
 * PII policy: Shopify's payload includes customer.email/phone, but the audit
 * row persists an allow-listed, PII-free projection of the payload (see
 * sanitizeCompliancePayload) — contact info is omitted entirely, never stored.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const p = (payload ?? {}) as Record<string, any>;

  try {
    const ordersToRedact = Array.isArray(p.orders_to_redact)
      ? p.orders_to_redact.map(String)
      : [];

    let deleted = 0;
    if (ordersToRedact.length > 0) {
      const res = await db.events.deleteMany({
        where: { shop_domain: shop, order_id: { in: ordersToRedact } },
      });
      deleted = res.count;
    }

    const customerId = (p.customer as Record<string, unknown> | undefined)?.id ?? null;

    await recordComplianceRequest({
      shopDomain: shop,
      topic: TOPIC,
      // Allow-listed projection — customer.email/phone from the raw payload are
      // NOT persisted (see sanitizeCompliancePayload for the keep/drop policy).
      payload: sanitizeCompliancePayload({
        shopDomain: shop,
        customer: p.customer,
        orders: p.orders_to_redact,
        orderField: "orders_to_redact",
        matchedEventIds: [],
      }),
      actionTaken:
        `Customer redaction. Deleted ${deleted} event row(s) for customer_id=${customerId ?? "-"} ` +
        `(orders: [${ordersToRedact.join(",") || "-"}]). No PII fields persisted in this record. ` +
        `Anonymous visitor browsing data not tied to a customer identity was left intact.`,
    });

    console.log(`${LOG_PREFIX} ${shop} frameworkTopic=${topic} canonical=${TOPIC} orders=${ordersToRedact.length} deletedEvents=${deleted}`);

    return new Response();
  } catch (err) {
    console.error(`${LOG_PREFIX} FAILED for ${shop}:`, err);
    throw err;
  }
};