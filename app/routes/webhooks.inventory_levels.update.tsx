import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../utils/webhook-auth.server";
import db from "../db.server";
import { handleInventoryLevelUpdate } from "../utils/product-sync.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

const MODULE = "webhooks.inventory_levels.update";

const LOG = "[product-sync:inventory_update]";

/**
 * inventory_levels/update — resolve the product locally via its stored
 * inventory_item_ids and refresh inventory_available. Multi-variant products
 * are location-scoped and not summable from one event: logged, left to the
 * daily reconciliation (see app/utils/product-sync.server.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateWebhook(request, MODULE);
  try {
    const result = await handleInventoryLevelUpdate(db, shop, payload);
    logInfo(
      { module: MODULE, shop_domain: shop },
      `${LOG} ${shop} topic=${topic} productId=${result.product_id} updated=${result.updated}`,
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
