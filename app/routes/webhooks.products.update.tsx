import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { upsertProductFromWebhook } from "../utils/product-sync.server";

const LOG = "[product-sync:products_update]";

/**
 * products/update — price edits, stock changes, status changes (draft/archived
 * flip deleted_at via the shared normalization). Sync failure is logged LOUDLY
 * and rethrown as a 500 so Shopify retries.
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
