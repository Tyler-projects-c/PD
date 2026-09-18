import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../utils/webhook-auth.server";
import db from "../db.server";
import { markProductDeleted } from "../utils/product-sync.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

const MODULE = "webhooks.products.delete";

const LOG = "[product-sync:products_delete]";

/**
 * products/delete — FLAG the local row deleted (never delete: products is the
 * FK parent of product_surface_stats; deleting would destroy attribution
 * history). See app/utils/product-sync.server.ts.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateWebhook(request, MODULE);
  try {
    const productId = await markProductDeleted(db, shop, payload);
    logInfo(
      { module: MODULE, shop_domain: shop },
      `${LOG} ${shop} topic=${topic} productId=${productId} flagged deleted`,
    );
    return new Response();
  } catch (error) {
    logError(
      { module: MODULE, shop_domain: shop },
      `${LOG} FAILED for ${shop}`,
      error,
    );
    throw error; // 500 -> Shopify retries
  }
};
