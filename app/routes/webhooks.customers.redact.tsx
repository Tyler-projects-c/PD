import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR redaction: store owner requests deletion of a customer's data.
 * Shopify sends shop_id, shop_domain, customer, and orders_to_redact.
 * Registration: shopify.app.toml -> [[webhooks.subscriptions]] compliance_topics.
 * Handler logic lands in a later change; for now this acknowledges receipt.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[gdpr] ${topic} for ${shop} (redact)`, {
    shop_id: (payload as any)?.shop_id,
    customer_id: (payload as any)?.customer?.id,
  });

  return new Response();
};