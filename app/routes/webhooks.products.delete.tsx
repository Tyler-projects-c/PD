import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markProductDeleted } from "../utils/product-sync.server";

const LOG = "[product-sync:products_delete]";

/**
 * products/delete — FLAG the local row deleted (never delete: products is the
 * FK parent of product_surface_stats; deleting would destroy attribution
 * history). See app/utils/product-sync.server.ts.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  try {
    const productId = await markProductDeleted(db, shop, payload);
    console.log(`${LOG} ${shop} topic=${topic} productId=${productId} flagged deleted`);
    return new Response();
  } catch (error) {
    console.error(`${LOG} FAILED for ${shop}:`, error);
    throw error; // 500 -> Shopify retries
  }
};
