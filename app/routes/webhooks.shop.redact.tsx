import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Shop redact: 48h after uninstall, Shopify asks the app to erase all data
 * it stored for that shop. Payload: shop_id, shop_domain.
 * Registration: shopify.app.toml -> [[webhooks.subscriptions]] compliance_topics.
 * Handler logic lands in a later change; for now this acknowledges receipt.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[gdpr] ${topic} for ${shop} (shop_redact)`, {
    shop_id: (payload as any)?.shop_id,
  });

  return new Response();
};