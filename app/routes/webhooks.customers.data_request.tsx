import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR data request: customer asks the store owner for a copy of their data.
 * Shopify sends shop_id, shop_domain, orders_requested, and a customer object.
 * The app must return the customer's data to the store owner directly.
 * Registration: shopify.app.toml -> [[webhooks.subscriptions]] compliance_topics.
 * Handler logic lands in a later change; for now this acknowledges receipt.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[gdpr] ${topic} for ${shop} (data_request)`, {
    shop_id: (payload as any)?.shop_id,
    data_request_id: (payload as any)?.data_request?.id,
  });

  return new Response();
};