import type { Prisma } from "@prisma/client";
import db from "../db.server";

/**
 * Builds the PII-minimal JSON object persisted to compliance_requests.payload.
 *
 * This is an ALLOW-LIST, not a deny-list: any field not explicitly copied here
 * (including contact fields Shopify includes in GDPR webhook payloads, or any
 * Shopify may add in the future) can never reach the audit trail by accident.
 *
 * Kept (identifiers only — prove receipt, scope and outcome):
 *   - shop_domain            which store the request concerns
 *   - customer.id            numeric Shopify customer id — not identifying on
 *                            its own without cross-referencing Shopify's systems
 *   - orders_requested /     the order ids that scope the request
 *     orders_to_redact
 *   - data_request.id        Shopify's own request id (their audit correlation)
 *   - matched_event_ids      which of OUR event rows were found/redacted
 *
 * Dropped entirely (omitted, never masked): customer.email, customer.phone and
 * every other field of the raw payload. A masked value is still PII at rest;
 * an omitted one is not.
 */
export function sanitizeCompliancePayload(opts: {
  shopDomain: string;
  customer?: unknown;
  orders?: unknown;
  orderField: "orders_requested" | "orders_to_redact";
  dataRequestId?: unknown;
  matchedEventIds?: string[];
}): Record<string, unknown> {
  const customerId =
    typeof opts.customer === "object" && opts.customer !== null && "id" in (opts.customer as Record<string, unknown>)
      ? ((opts.customer as Record<string, unknown>).id ?? null)
      : null;

  const payload: Record<string, unknown> = {
    shop_domain: opts.shopDomain,
    customer: { id: customerId },
    [opts.orderField]: Array.isArray(opts.orders) ? opts.orders.map(String) : [],
    matched_event_ids: opts.matchedEventIds ?? [],
  };
  if (opts.dataRequestId != null) {
    payload.data_request = { id: opts.dataRequestId };
  }
  return payload;
}

/**
 * Writes one row to the compliance_requests audit table.
 *
 * This is our permanent, queryable record that a GDPR/privacy webhook was
 * received and what we did about it (topic, shop, sanitized payload,
 * timestamps, and a human-readable action_taken). It is the audit trail we can
 * point to if Shopify or a merchant ever asks how a data request / redaction
 * was handled.
 *
 * `payload` MUST already be PII-stripped by sanitizeCompliancePayload() —
 * this function deliberately does no sanitizing itself so that each handler
 * makes its allow-list explicit and reviewable.
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