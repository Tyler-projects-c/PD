/**
 * Order revenue verification — cross-references browser-reported
 * checkout_completed events against Shopify's own orders/paid webhook as the
 * authoritative revenue source.
 *
 * WHY: the pixel's checkout payload is browser-reported (client-computed totals,
 * network retries, double-fire bugs). The orders/paid webhook comes from
 * Shopify's order ledger — same order_id grain (one events row per line item,
 * matching the idempotency index idx_events_checkout_dedup). The raw `revenue`
 * column is NEVER overwritten: the webhook value lands in `verified_revenue`
 * alongside it, so both stay visible for debugging.
 *
 * MATCHING: by (shop_domain, order_id, product_id) on
 * event_type='checkout_completed' rows. Product-level first (per-line revenue);
 * if the webhook line has no numeric Shopify product id to match a row with
 * (e.g. a gift card or unmapped line), its amount is logged and skipped rather
 * than smeared across other lines.
 *
 * STATUS MODEL (per checkout row):
 *   pending    — no orders/paid webhook for this order_id yet (initial state).
 *   verified   — webhook matched and per-line revenue agrees within threshold.
 *   mismatch   — webhook matched but differs by more than the threshold; the
 *                webhook value still wins on verified_revenue, and a loud
 *                console.warn records both values.
 *   unverified — still no webhook after the 24h grace window (marked by
 *                sweepStaleVerifications, piggybacked on order webhooks).
 *
 * ROUNDING THRESHOLD: browser totals and Shopify ledger totals can legitimately
 * differ by a cent from float serialization (e.g. "78.95" -> Decimal(12,2)
 * round-trips), so per-line differences <= $0.01 are treated as agreement.
 * Anything larger is a real mismatch worth investigating.
 *
 * REPORTING: reads that summarize revenue go through effectiveRevenue() in
 * ./verified-revenue.ts (verified value when present, raw browser value while
 * verification is still pending) so this table stays the single measurement
 * source for attribution and the Thompson revenue weighting.
 *
 * This module is PURE (db injected, no runtime imports) — same pattern as
 * product-sync.server.ts — so the verify harness can drive it directly with
 * the real Prisma client and synthetic payloads.
 */

/** PrismaClient type only — erased at runtime (type stripping). */
import type { PrismaClient } from "@prisma/client";

const LOG = "[order-verification]";

/** Per-line agreement threshold: differences at or under a cent are rounding. */
export const VERIFICATION_ROUNDING_THRESHOLD = 0.01;
/** Grace window before an unmatched checkout is marked unverified (24h). */
export const VERIFICATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Minimal shape of an orders/paid webhook line item (REST payload). */
export interface PaidLineItem {
  product_id?: unknown;
  price?: unknown;
  quantity?: unknown;
  /** Fallback when price is absent: pre-tax line total. */
  price_set?: { shop_money?: { amount?: unknown } };
}

function finiteNumber(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Numeric Shopify product id from a REST line item, or null if unmappable. */
function lineProductId(line: PaidLineItem): string | null {
  const raw = line.product_id;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || !/^\d+$/.test(s)) return null;
  return s;
}

/** Per-unit price for a webhook line: price, else price_set.shop_money.amount. */
function lineUnitPrice(line: PaidLineItem): number {
  let unit = finiteNumber(line.price);
  if (!Number.isFinite(unit) || unit < 0) {
    unit = finiteNumber(line.price_set?.shop_money?.amount);
  }
  if (!Number.isFinite(unit) || unit < 0) return NaN;
  return unit;
}

/** Quantity for a webhook line (defaults to 1 when absent/invalid). */
function lineQuantity(line: PaidLineItem): number {
  const q = finiteNumber(line.quantity);
  if (!Number.isFinite(q) || q <= 0) return 1;
  return Math.floor(q);
}

export interface PaidOrderShape {
  id?: unknown;
  order_id?: unknown;
  name?: unknown;
  line_items?: unknown;
}

/**
 * Normalize an orders/paid REST payload into matchable per-line amounts.
 * Returns the order id (numeric string) and a product_id -> revenue map,
 * plus counts of skipped lines for loud logging.
 */
export function normalizePaidOrder(payload: PaidOrderShape): {
  orderId: string;
  lines: Map<string, number>;
  skippedLines: number;
  orderName: string | null;
} {
  const rawId = payload.order_id ?? payload.id;
  const orderId = /^\d+$/.test(String(rawId ?? "").trim()) ? String(rawId).trim() : "";
  const lines = new Map<string, number>();
  let skippedLines = 0;
  const rawLines = Array.isArray(payload.line_items) ? (payload.line_items as PaidLineItem[]) : [];
  for (const line of rawLines) {
    const pid = lineProductId(line);
    const unit = lineUnitPrice(line);
    if (!pid || !Number.isFinite(unit)) {
      skippedLines++;
      continue;
    }
    const qty = lineQuantity(line);
    lines.set(pid, round2((lines.get(pid) ?? 0) + unit * qty));
  }
  const orderName = typeof payload.name === "string" && payload.name ? payload.name : null;
  return { orderId, lines, skippedLines, orderName };
}

export interface VerifyPaidOrderResult {
  order_id: string;
  matchedRows: number;
  verifiedRows: number;
  mismatchRows: number;
  skippedLines: number;
}

/**
 * Apply an orders/paid webhook to existing checkout_completed rows.
 * Never throws for data reasons (unknown shop, empty payload, no matching
 * rows are all logged, not fatal) — the route decides retry semantics.
 */
export async function verifyPaidOrder(
  db: PrismaClient,
  shopDomain: string,
  payload: PaidOrderShape,
): Promise<VerifyPaidOrderResult> {
  const { orderId, lines, skippedLines, orderName } = normalizePaidOrder(payload);
  if (!orderId) {
    console.warn(`${LOG} ${shopDomain} orders/paid payload has no numeric order id; SKIPPED`);
    return { order_id: "", matchedRows: 0, verifiedRows: 0, mismatchRows: 0, skippedLines };
  }
  if (skippedLines > 0) {
    console.warn(
      `${LOG} ${shopDomain} order ${orderId}: ${skippedLines} webhook line(s) had no mappable numeric product id and were SKIPPED (not smeared across other lines)`,
    );
  }

  const rows = await db.events.findMany({
    where: { shop_domain: shopDomain, event_type: "checkout_completed", order_id: orderId },
    select: { event_id: true, product_id: true, revenue: true },
  });
  if (rows.length === 0) {
    // No browser rows (yet) for this order: legitimate when the webhook wins
    // the race (webhook delivery often beats the thank-you-page pixel). Log
    // loudly — if rows NEVER arrive this is the signal — and let a later
    // retry or reconciliation pass pick it up.
    console.warn(
      `${LOG} ${shopDomain} order ${orderId}${orderName ? ` (${orderName})` : ""}: ` +
        `no checkout_completed rows yet for ${lines.size} webhook line(s); will retry on redelivery`,
    );
    return { order_id: orderId, matchedRows: 0, verifiedRows: 0, mismatchRows: 0, skippedLines };
  }

  let matchedRows = 0;
  let verifiedRows = 0;
  let mismatchRows = 0;
  const now = new Date();
  for (const row of rows) {
    const pid = row.product_id ?? "";
    const webhookAmount = lines.get(pid);
    if (webhookAmount === undefined) continue; // no webhook line for this row
    matchedRows++;
    const browserAmount =
      row.revenue === null || row.revenue === undefined ? NaN : Number(row.revenue);
    const diff = Math.abs(webhookAmount - browserAmount);
    if (Number.isFinite(browserAmount) && diff > VERIFICATION_ROUNDING_THRESHOLD) {
      mismatchRows++;
      console.warn(
        `${LOG} MISMATCH ${shopDomain} order ${orderId} product ${pid}: ` +
          `browser=${browserAmount} webhook=${webhookAmount} diff=${round2(diff)} — webhook wins`,
      );
    } else {
      verifiedRows++;
    }
    await db.events.update({
      where: { event_id: row.event_id },
      data: {
        verified_revenue: webhookAmount,
        verification_status: diff > VERIFICATION_ROUNDING_THRESHOLD ? "mismatch" : "verified",
        verified_at: now,
      },
    });
  }

  if (matchedRows === 0) {
    console.warn(
      `${LOG} ${shopDomain} order ${orderId}: ${rows.length} checkout row(s) but none matched the ${lines.size} webhook line(s) by product_id`,
    );
  } else {
    console.log(
      `${LOG} ${shopDomain} order ${orderId}: matched=${matchedRows} verified=${verifiedRows} mismatch=${mismatchRows}`,
    );
  }
  return { order_id: orderId, matchedRows, verifiedRows, mismatchRows, skippedLines };
}

/**
 * 24h grace sweep: mark still-pending checkout rows whose order is older than
 * the grace window as unverified. Piggybacked on order webhooks (this app has
 * no cron — same pattern as the daily reconciliation gate). Returns the count
 * marked. Never throws: a failed sweep must not take the webhook down.
 */
export async function sweepStaleVerifications(
  db: PrismaClient,
  shopDomain: string,
  now = new Date(),
): Promise<{ marked: number }> {
  try {
    const cutoff = new Date(now.getTime() - VERIFICATION_GRACE_MS);
    const result = await db.events.updateMany({
      where: {
        shop_domain: shopDomain,
        event_type: "checkout_completed",
        verification_status: "pending",
        occurred_at: { lt: cutoff },
      },
      data: { verification_status: "unverified" },
    });
    if (result.count > 0) {
      console.warn(
        `${LOG} ${shopDomain} marked ${result.count} checkout row(s) unverified (no orders/paid webhook within 24h)`,
      );
    }
    return { marked: result.count };
  } catch (error) {
    console.error(
      `${LOG} ${shopDomain} stale-verification sweep FAILED (will retry on next order webhook):`,
      error instanceof Error ? error.message : error,
    );
    return { marked: 0 };
  }
}