import type { ActionFunctionArgs } from "react-router";
import { sessionStorage } from "../shopify.server";
import { authenticateWebhook } from "../utils/webhook-auth.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

const MODULE = "webhooks.app.scopes_update";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticateWebhook(request, MODULE);
  logInfo({ module: MODULE, shop_domain: shop }, `Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    session.scope = current.toString();
    await sessionStorage.storeSession(session);
  }

  return new Response();
};
