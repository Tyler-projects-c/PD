import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../utils/webhook-auth.server";
import db from "../db.server";
import { sweepStaleVerifications, verifyPaidOrder } from "../utils/order-verification.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

const MODULE = "webhooks.orders.paid";

const LOG = "[product-sync:orders_paid]";

/**
 * orders/paid — Shopify's order ledger is the authoritative revenue source.
 * Cross-references the webhook's per-line amounts against the browser-reported
 * checkout_completed rows (raw `revenue` is never overwritten — the webhook
 * value lands in `verified_revenue`; see app/utils/order-verification.server.ts).
 * Also piggybacks the 24h stale-verification sweep (no cron in this app).
 * Verification failure is logged LOUDLY and rethrown as a 500 so Shopify
 * retries; the sweep itself never throws.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticateWebhook(request, MODULE);
  try {
    const result = await verifyPaidOrder(db, shop, payload as Record<string, unknown>);
    logInfo(
      { module: MODULE, shop_domain: shop },
      `${LOG} ${shop} topic=${topic} order=${result.order_id} matched=${result.matchedRows} verified=${result.verifiedRows} mismatch=${result.mismatchRows}`,
    );
    const sweep = await sweepStaleVerifications(db, shop);
    if (sweep.marked > 0) {
      logInfo(
        { module: MODULE, shop_domain: shop },
        `${LOG} ${shop} stale sweep marked=${sweep.marked}`,
      );
    }
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
