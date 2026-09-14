import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { upsertProductFromWebhook } from "../utils/product-sync.server";

const LOG = "[product-sync:products_create]";

/**
 * products/create — upsert the new product's price/inventory/item-ids/status.
 * Sync failure is logged LOUDLY and rethrown as a 500 so Shopify retries
 * (a silently swallowed sync failure is exactly the bug class this project
 * has been bitten by before).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  try {
    const productId = await upsertProductFromWebhook(db, shop, payload);
    console.log(`${LOG} ${shop} topic=${topic} productId=${productId} upserted`);
    return new Response();
  } catch (error) {
    console.error(`${LOG} FAILED for ${shop}:`, error);
    throw error; // 500 -> Shopify retries
  }
};
