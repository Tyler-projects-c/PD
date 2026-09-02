import type { Prisma } from "@prisma/client";
import db from "../db.server";

/**
 * Writes one row to the compliance_requests audit table.
 *
 * This is our permanent, queryable record that a GDPR/privacy webhook was
 * received and what we did about it (topic, shop, raw payload, timestamps,
 * and a human-readable action_taken). It is the audit trail we can point to
 * if Shopify or a merchant ever asks how a data request / redaction was
 * handled.
 *
 * `client` lets callers write inside an existing transaction (atomic with
 * other mutations); it defaults to the global db client.
 */
export async function recordComplianceRequest(opts: {
  shopDomain: string;
  topic: string;
  payload: unknown;
  actionTaken: string;
  client?: Prisma.TransactionClient | typeof db;
}): Promise<string> {
  const client = opts.client ?? db;
  const row = await client.compliance_requests.create({
    data: {
      shop_domain: opts.shopDomain,
      topic: opts.topic,
      payload: (opts.payload ?? {}) as Prisma.InputJsonValue,
      processed_at: new Date(),
      action_taken: opts.actionTaken,
    },
  });
  return row.request_id;
}