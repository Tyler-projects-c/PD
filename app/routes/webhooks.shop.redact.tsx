import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordComplianceRequest } from "../utils/compliance.server";

const LOG_PREFIX = "[gdpr:shop_redact]";

// Canonical webhook topic (matches compliance_requests_topic_check constraint).
const TOPIC = "shop/redact";

/**
 * shop/redact (GDPR) — fires ~48h after a store uninstalls the app.
 *
 * Payload per https://shopify.dev/docs/apps/build/privacy-law-compliance:
 *   { shop_id, shop_domain }
 *
 * We must erase ALL data PD holds for that shop. We delete every row tied to
 * shop_domain across every table in a SINGLE transaction (atomic): events,
 * experiment_assignments, product_surface_stats, products, visitors,
 * compliance_requests, and the shops row itself. If the shop has no data (or
 * was never installed), the deletes are no-ops and we still return success —
 * "nothing to redact" is a valid outcome.
 *
 * The request receipt itself is recorded in compliance_requests BEFORE the
 * data wipe in the same transaction, so the audit record is atomic with the
 * wipe (if the wipe fails, the audit row rolls back too and we surface an
 * error so Shopify retries). HMAC verification is automatic.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const p = (payload ?? {}) as Record<string, any>;

  try {
    const result = await db.$transaction(
      async (tx) => {
      // 1) Record receipt (atomic with the wipe below). Allow-listed payload:
      //    shop/redact carries no customer contact info (only shop ids), but
      //    we persist an explicit projection anyway so any future Shopify
      //    payload additions can never leak into the audit trail.
      const auditId = await recordComplianceRequest({
        shopDomain: shop,
        topic: TOPIC,
        payload: { shop_domain: shop, shop_id: p.shop_id ?? null },
        actionTaken: "shop/redact received - erasing all PD data for this shop.",
        client: tx,
      });

      // 2) Delete all shop data EXCEPT this request's audit row (which is the
      //    permanent proof that the redaction ran, per requirement #4). Prior
      //    compliance payloads for this shop may contain customer PII from
      //    earlier data_request/redact receipts, so they must be wiped.
      const events = await tx.events.deleteMany({ where: { shop_domain: shop } });
      const assignments = await tx.experiment_assignments.deleteMany({ where: { shop_domain: shop } });
      const stats = await tx.product_surface_stats.deleteMany({ where: { shop_domain: shop } });
      const products = await tx.products.deleteMany({ where: { shop_domain: shop } });
      const visitors = await tx.visitors.deleteMany({ where: { shop_domain: shop } });
      const compliance = await tx.compliance_requests.deleteMany({
        where: { shop_domain: shop, request_id: { not: auditId } },
      });
      const shops = await tx.shops.deleteMany({ where: { shop_domain: shop } });

      // 3) Update the audit row with the final action summary (still in tx).
      await tx.compliance_requests.update({
        where: { request_id: auditId },
        data: {
          action_taken: `shop/redact complete. Deleted: events=${events.count}, assignments=${assignments.count}, stats=${stats.count}, products=${products.count}, visitors=${visitors.count}, compliance_requests=${compliance.count}, shops=${shops.count}.`,
        },
      });

      return {
        events: events.count,
        assignments: assignments.count,
        stats: stats.count,
        products: products.count,
        visitors: visitors.count,
        compliance: compliance.count,
        shops: shops.count,
      };
      },
      // Generous timeout: this webhook runs unattended and may hit Neon
      // cold-start / pooled-connection latency on the first few queries.
      // Prisma's default interactive-transaction timeout is 5s, which this
      // multi-statement wipe can exceed. Shopify re-delivers on failure, so
      // a slow-but-successful response is strictly better than a false 500.
      { timeout: 30_000 },
    );

    console.log(`${LOG_PREFIX} ${shop} frameworkTopic=${topic} canonical=${TOPIC} erased=${JSON.stringify(result)}`);
    return new Response();
  } catch (err) {
    console.error(`${LOG_PREFIX} FAILED for ${shop}:`, err);
    throw err;
  }
};