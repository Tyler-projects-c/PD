import type { ActionFunctionArgs } from "react-router";
import { sessionStorage } from "../shopify.server";
import { authenticateWebhook } from "../utils/webhook-auth.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

const MODULE = "webhooks.app.uninstalled";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticateWebhook(request, MODULE);

  logInfo({ module: MODULE, shop_domain: shop }, `Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await sessionStorage.deleteSession(session.id);
  }

  return new Response();
};
