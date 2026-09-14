import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleInventoryLevelUpdate } from "../utils/product-sync.server";

const LOG = "[product-sync:inventory_update]";

/**
 * inventory_levels/update — resolve the product locally via its stored
 * inventory_item_ids and refresh inventory_available. Multi-variant products
 * are location-scoped and not summable from one event: logged, left to the
 * daily reconciliation (see app/utils/product-sync.server.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  try {
    const result = await handleInventoryLevelUpdate(db, shop, payload);
    console.log(`${LOG} ${shop} topic=${topic} productId=${result.product_id} updated=${result.updated}`);
    return new Response();
  } catch (error) {
    console.error(`${LOG} FAILED for ${shop}:`, error);
    throw error; // 500 -> Shopify retries
  }
};
