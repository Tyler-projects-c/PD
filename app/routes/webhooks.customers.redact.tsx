import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordComplianceRequest } from "../utils/compliance.server";

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

    await recordComplianceRequest({
      shopDomain: shop,
      topic: TOPIC,
      payload: p,
      actionTaken:
        `Customer redaction. Deleted ${deleted} event row(s) linked to orders_to_redact=[${ordersToRedact.join(",") || "-"}]. ` +
        `No customer email/phone/customer_id stored by the app. Anonymous visitor browsing data not tied to a customer identity was left intact.`,
    });

    console.log(`${LOG_PREFIX} ${shop} frameworkTopic=${topic} canonical=${TOPIC} orders=${ordersToRedact.length} deletedEvents=${deleted}`);

    return new Response();
  } catch (err) {
    console.error(`${LOG_PREFIX} FAILED for ${shop}:`, err);
    throw err;
  }
};