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
 * WEBHOOK-FIRST RACE: the orders/paid webhook routinely beats the
 * thank-you-page pixel, so NO browser rows exist yet when it arrives. A 200 has
 * already been returned (Shopify redelivers only non-2xx), so the correct move
 * is to PARK the post-discount per-line amounts in the webhook_revenue_ledger
 * table (keyed by shop_domain/order_id/product_id). persistEvent in
 * app/routes/api.events.tsx consumes the parked rows the moment the late
 * checkout_completed rows are inserted and marks them verified/mismatch
 * immediately - no redelivery needed or expected.
 *
 * STATUS MODEL (per checkout row):
 *   pending    — no orders/paid webhook for this order_id yet (initial state).
 *   verified   — webhook matched and per-line revenue agrees within threshold.
 *   mismatch   — webhook matched but differs by more than the threshold; the
 *                webhook value still wins on verified_revenue, and a loud
 *                structured warn (Sentry-visible — this is a trust-claim
 *                signal, not routine traffic) records both values.
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
 * This module is PURE (db injected, no runtime imports beyond the logger) —
 * same pattern as product-sync.server.ts — so the verify harness can drive
 * it directly with the real Prisma client and synthetic payloads.
 */

/** PrismaClient type only — erased at runtime (type stripping). */
import type { PrismaClient } from "@prisma/client";
import { logError, logInfo, logWarn } from "./logger.server.ts";

const LOG = "[order-verification]";
const MODULE = "order-verification";

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
/** Total discount allocated to one line via its discount_allocations entries. */
function lineDiscountShare(line: PaidLineItem): number {
  const entries = (line as PaidLineItem & { discount_allocations?: unknown }).discount_allocations;
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const entry of entries) {
    const e = entry as { amount?: unknown; amount_set?: { shop_money?: { amount?: unknown } } };
    const n = finiteNumber(e.amount);
    total += Number.isFinite(n) ? n : finiteNumber(e.amount_set?.shop_money?.amount) || 0;
  }
  return round2(total);
}

/**
 * Post-discount authoritative amount for one webhook line.
 *
 * The webhook `price` (or the price_set fallback) is the PRE-discount unit
 * price; the pixel reports the POST-discount finalLinePrice. Comparing the raw
 * webhook amount against the browser value therefore produced a false
 * mismatch on EVERY discounted order. Shopify reports each line share of
 * the discount in `discount_allocations[].amount[_set]` - subtract the line total
 * allocation from (unit price x quantity) before comparing or storing.
 */
function discountedLineAmount(line: PaidLineItem): number {
  const unit = lineUnitPrice(line);
  if (!Number.isFinite(unit)) return NaN;
  const gross = unit * lineQuantity(line);
  // Shopify never reports a line's final price below zero (a fully discounted
  // line is 0.00), so clamp here too: an over-allocated discount must not push
  // negative revenue into verified_revenue or the webhook ledger.
  return round2(Math.max(0, gross - lineDiscountShare(line)));
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
    const amount = discountedLineAmount(line);
    if (!pid || !Number.isFinite(amount)) {
      skippedLines++;
      continue;
    }
    // Multiple lines for the same product (split fulfillments, edits):
    // SUM the post-discount amounts rather than letting the last line win.
    lines.set(pid, round2((lines.get(pid) ?? 0) + amount));
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
/** Ledger upsert for the webhook-first race: park (or refresh) one line amount. */
async function txLedgerUpsert(
  db: PrismaClient,
  shopDomain: string,
  orderId: string,
  productId: string,
  amount: number,
): Promise<void> {
  await db.webhook_revenue_ledger.upsert({
    where: { shop_domain_order_id_product_id: { shop_domain: shopDomain, order_id: orderId, product_id: productId } },
    update: { amount, received_at: new Date() },
    create: { shop_domain: shopDomain, order_id: orderId, product_id: productId, amount },
  });
}
/**
 * Consume parked webhook-first ledger rows for one order: called from
 * persistEvent in app/routes/api.events.tsx right after the late
 * checkout_completed rows are inserted. For every checkout row whose
 * verification is still pending AND whose ledger entry exists, write the
 * parked post-discount amount into verified_revenue with the correct status
 * (verified within threshold, mismatch with a Sentry-visible warn otherwise)
 * and delete the consumed ledger rows. Ledger rows with NO matching browser
 * row are left parked (the pixel may still be in flight); rows older than 30
 * days are pruned here since their browser row will never arrive.
 */
export async function reconcileLedgerForOrder(
  db: PrismaClient,
  shopDomain: string,
  orderId: string | null | undefined,
): Promise<{ consumed: number; verified: number; mismatched: number }> {
  const empty = { consumed: 0, verified: 0, mismatched: 0 };
  if (!orderId) return empty;
  const parked = await db.webhook_revenue_ledger.findMany({
    where: { shop_domain: shopDomain, order_id: orderId },
  });
  if (parked.length === 0) return empty;
  const rows = await db.events.findMany({
    where: {
      shop_domain: shopDomain,
      event_type: "checkout_completed",
      order_id: orderId,
      verification_status: "pending",
    },
  });
  const parkedByProduct = new Map(parked.map((p) => [p.product_id, p]));
  const now = new Date();
  let consumed = 0;
  let verified = 0;
  let mismatched = 0;
  for (const row of rows) {
    const pid = row.product_id ?? "";
    const entry = parkedByProduct.get(pid);
    if (!entry) continue;
    const webhookAmount = Number(entry.amount);
    const browserAmount =
      row.revenue === null || row.revenue === undefined ? NaN : Number(row.revenue);
    const diff = Math.abs(webhookAmount - browserAmount);
    const match = Number.isFinite(browserAmount) && diff <= VERIFICATION_ROUNDING_THRESHOLD;
    if (match) {
      verified++;
    } else {
      mismatched++;
      logWarn(
        { module: MODULE, shop_domain: shopDomain },
        `${LOG} MISMATCH (ledger) ${shopDomain} orderId=${orderId} product=${pid}`,
        {
          extra: {
            order_id: orderId,
            product_id: pid,
            browser_amount: Number.isFinite(browserAmount) ? browserAmount : null,
            webhook_amount: webhookAmount,
            diff: round2(diff),
            source: "webhook_revenue_ledger",
          },
          sentry: true,
        },
      );
    }
    await db.events.update({
      where: { event_id: row.event_id },
      data: {
        verified_revenue: webhookAmount,
        verification_status: match ? "verified" : "mismatch",
        verified_at: now,
      },
    });
    await db.webhook_revenue_ledger.delete({
      where: {
        shop_domain_order_id_product_id: {
          shop_domain: shopDomain,
          order_id: orderId,
          product_id: pid,
        },
      },
    });
    parkedByProduct.delete(pid);
    consumed++;
  }
  const staleCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await db.webhook_revenue_ledger.deleteMany({
    where: { shop_domain: shopDomain, order_id: orderId, received_at: { lt: staleCutoff } },
  });
  if (consumed > 0) {
    logInfo(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} order ${orderId}: ledger reconcile consumed=${consumed} verified=${verified} mismatched=${mismatched}`,
    );
  }
  return { consumed, verified, mismatched };
}



export async function verifyPaidOrder(
  db: PrismaClient,
  shopDomain: string,
  payload: PaidOrderShape,
): Promise<VerifyPaidOrderResult> {
  const { orderId, lines, skippedLines, orderName } = normalizePaidOrder(payload);
  if (!orderId) {
    // Malformed orders/paid payload: Shopify ALWAYS sends a numeric order id,
    // so its absence means the payload is malformed (or tampered with) and we
    // are silently NOT verifying revenue for it. That directly touches the
    // "provably measured" claim, so it is Sentry-visible, not console-only.
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} orders/paid payload has no numeric order id; SKIPPED`,
      { sentry: true, extra: { malformed_webhook: true } },
    );
    return { order_id: "", matchedRows: 0, verifiedRows: 0, mismatchRows: 0, skippedLines };
  }
  if (skippedLines > 0) {
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} order ${orderId}: ${skippedLines} webhook line(s) had no mappable numeric product id and were SKIPPED (not smeared across other lines)`,
    );
  }

  const rows = await db.events.findMany({
    where: { shop_domain: shopDomain, event_type: "checkout_completed", order_id: orderId },
    select: { event_id: true, product_id: true, revenue: true },
  });
  if (rows.length === 0) {
    // Webhook-first race: orders/paid routinely beats the thank-you-page pixel,
    // so NO browser rows exist yet. A 200 was already returned and Shopify
    // redelivers only non-2xx, so PARK the post-discount per-line amounts in
    // the webhook_revenue_ledger (keyed by shop_domain/order_id/product_id).
    // persistEvent in app/routes/api.events.tsx consumes parked rows the moment
    // the late checkout_completed rows are inserted - no redelivery needed.
    let parked = 0;
    for (const [pid, amount] of lines) {
      try {
        await txLedgerUpsert(db, shopDomain, orderId, pid, amount);
        parked++;
      } catch (error) {
        logError(
          { module: MODULE, shop_domain: shopDomain },
          `${LOG} ${shopDomain} order ${orderId} product ${pid}: FAILED to park webhook amount ${amount} in the verification ledger`,
          error,
        );
      }
    }
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} order ${orderId}${orderName ? ` (${orderName})` : ""}: ` +
        `no checkout_completed rows yet for ${lines.size} webhook line(s); parked ${parked} in the verification ledger`,
    );
    return { order_id: orderId, matchedRows: 0, verifiedRows: 0, mismatchRows: 0, skippedLines };
  }
  let mismatchRows = 0;
  let matchedRows = 0;
  let verifiedRows = 0;
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
      // Trust-claim signal: a real browser-vs-ledger disagreement is Sentry
      // visible (alerting only — a human reviews every mismatch).
      logWarn(
        { module: MODULE, shop_domain: shopDomain },
        `${LOG} MISMATCH ${shopDomain} order ${orderId} product ${pid}: ` +
          `browser=${browserAmount} webhook=${webhookAmount} diff=${round2(diff)} — webhook wins`,
        {
          extra: {
            order_id: orderId,
            product_id: pid,
            browser_amount: browserAmount,
            webhook_amount: webhookAmount,
            diff: round2(diff),
          },
          sentry: true,
        },
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
    logWarn(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} order ${orderId}: ${rows.length} checkout row(s) but none matched the ${lines.size} webhook line(s) by product_id`,
    );
  } else {
    logInfo(
      { module: MODULE, shop_domain: shopDomain },
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
      logWarn(
        { module: MODULE, shop_domain: shopDomain },
        `${LOG} ${shopDomain} marked ${result.count} checkout row(s) unverified (no orders/paid webhook within 24h)`,
      );
    }
    return { marked: result.count };
  } catch (error) {
    logError(
      { module: MODULE, shop_domain: shopDomain },
      `${LOG} ${shopDomain} stale-verification sweep FAILED (will retry on next order webhook)`,
      error,
    );
    return { marked: 0 };
  }
}




