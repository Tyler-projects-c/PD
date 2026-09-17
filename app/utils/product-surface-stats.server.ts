/**
 * Daily rollup for product_surface_stats — the aggregation target that feeds
 * the Thompson ranking candidate read (see thompson-ranking.server.ts).
 *
 * CADENCE (locked design decision #3): refreshed ONCE per UTC day per
 * (shop_domain, surface, surface_ref) instance, piggybacked on the first
 * ranking request of a new UTC day (the same cadence as the daily-resample
 * draw). There is NO standalone job/cron service in this app (verified); the
 * rank route calls ensureSurfaceStatsFresh() before drawing, which runs
 * refreshSurfaceStats() only when the instance's newest row is older than
 * today's UTC midnight (or the instance has no stats yet).
 *
 * SEMANTICS (locked design decisions #1/#2):
 *   - Target table: product_surface_stats (product_id, shop_domain, surface,
 *     surface_ref) -> impressions / clicks / purchases / revenue / last_updated.
 *   - `purchases` per product uses computeAttribution(windowDays: 30) — the
 *     call-site override ONLY; attribution.server.ts's DEFAULT_WINDOW_DAYS and
 *     every other caller are untouched. 30 days suits considered-purchase
 *     catalogs. Per-product purchases = distinct assigned visitors whose
 *     checkout for that product falls within [assigned_at, assigned_at + 30d],
 *     exactly mirroring computeAttribution's temporal rule (the consumer of
 *     this table, the Thompson module, needs binary per-visitor conversions).
 *   - Impressions count product_impression events on the instance. No
 *     inflation/correction for still-settling recent impressions — the daily
 *     refresh naturally re-settles the numbers (accept the lag).
 *   - The pipeline has no "click" event type, so clicks is written as 0 and
 *     the column is documented, not silently dead.
 *   - revenue = sum of the matched checkout revenue (2dp).
 *
 * FK SAFETY: product_surface_stats.product_id references products
 * (product_id, shop_domain), so a stats row can ONLY exist for a product row.
 * This rollup therefore computes rows only for product_ids present in the
 * `products` table (the candidate universe); any event product_id without a
 * matching products row is skipped loudly rather than violating the FK. The
 * ranking layer adds zero-history products from `products` as candidates with
 * {impressions: 0, conversions: 0} (locked design decision #4) — that step
 * lives in thompson-ranking.server.ts, not here.
 */

import db from "../db.server";
import { computeAttribution } from "./attribution.server";
import { effectiveRevenue } from "./verified-revenue";

/** Locked override: purchases window = 30 days (never 14) for this table. */
export const SURFACE_STATS_WINDOW_DAYS = 30;

const WINDOW_MS = SURFACE_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface InstanceStatsRow {
  product_id: string;
  impressions: number;
  clicks: number;
  purchases: number;
  revenue: number;
}

export interface RefreshSurfaceStatsResult {
  shop_domain: string;
  surface: string;
  surface_ref: string;
  rows: InstanceStatsRow[];
  /** Instance-level control/treatment attribution under windowDays:30. */
  attribution: Awaited<ReturnType<typeof computeAttribution>>;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
/**
 * Recompute product_surface_stats rows for ONE instance
 * (shop_domain, surface, surface_ref) from the events table and persist them.
 * The instance's rows are replaced atomically (delete + create in one
 * transaction) so the table is always a coherent daily snapshot.
 */
export async function refreshSurfaceStats(opts: {
  shop_domain: string;
  surface: string;
  surface_ref: string;
}): Promise<RefreshSurfaceStatsResult> {
  const { shop_domain, surface, surface_ref } = opts;

  // Candidate universe for the FK: every product row for the shop.
  const productRows = await db.products.findMany({
    where: { shop_domain },
    select: { product_id: true },
  });
  const knownProducts = new Map(productRows.map((p) => [p.product_id, true]));

  // 1) Assignments for THIS instance -> assigned_at per visitor.
  const assignments = await db.experiment_assignments.findMany({
    where: { shop_domain, surface, surface_ref },
    select: { visitor_id: true, assigned_at: true },
  });
  const assignedAtByVisitor = new Map(
    assignments.map((a) => [a.visitor_id, a.assigned_at.getTime()]),
  );
  const visitorIds = assignments.map((a) => a.visitor_id);
// 2) Impressions per product: product_impression events on the instance.
  const impressionAgg = await db.events.groupBy({
    by: ["product_id"],
    where: {
      shop_domain,
      surface,
      surface_ref,
      event_type: "product_impression",
      product_id: { not: null },
    },
    _count: { _all: true },
  });

  // 3) Purchases + revenue per product: checkout_completed rows from the
  //    instance's assigned visitors, restricted to the same temporal window
  //    computeAttribution uses with windowDays:30 (at-or-after assigned_at,
  //    within assigned_at + 30d). Distinct visitors per product = binary
  //    conversions (what the Thompson candidate consumes).
  const buyersByProduct = new Map<string, Set<string>>();
  const revenueByProduct = new Map<string, number>();

  if (visitorIds.length > 0) {
    const checkouts = await db.events.findMany({
      where: {
        shop_domain,
        event_type: "checkout_completed",
        visitor_id: { in: visitorIds },
        product_id: { not: null },
      },
      select: {
        visitor_id: true,
        product_id: true,
        revenue: true,
        // Webhook-confirmed revenue from orders/paid, when it has landed.
        // Revenue reads prefer it and fall back to the raw browser value while
        // verification is pending — see ./verified-revenue.ts.
        verified_revenue: true,
        occurred_at: true,
      },
    });

    for (const ev of checkouts) {
      const pid = ev.product_id as string;
      const assignedMs = assignedAtByVisitor.get(ev.visitor_id);
      if (assignedMs === undefined) continue; // visitor not assigned to this instance
      const occurredMs = ev.occurred_at.getTime();
      if (occurredMs < assignedMs) continue; // backwards causality
      if (occurredMs > assignedMs + WINDOW_MS) continue; // outside 30d window
      if (!buyersByProduct.has(pid)) buyersByProduct.set(pid, new Set());
      buyersByProduct.get(pid)!.add(ev.visitor_id);
      // Revenue trust hardening: prefer the orders/paid-confirmed value, fall
      // back to the raw browser-reported value while verification is pending.
      revenueByProduct.set(pid, (revenueByProduct.get(pid) ?? 0) + effectiveRevenue(ev));
    }
  }

  // Assemble rows: only for products present in `products` (FK) and only when
  // the instance produced at least one impression or purchase.
  const rows: InstanceStatsRow[] = [];

  for (const g of impressionAgg) {
    const pid = g.product_id as string | null;
    if (!pid || !knownProducts.has(pid)) continue;
    const impressions = g._count._all;
    const purchases = buyersByProduct.get(pid)?.size ?? 0;
    const revenue = round2(revenueByProduct.get(pid) ?? 0);
    if (impressions === 0 && purchases === 0 && revenue === 0) continue;
    rows.push({ product_id: pid, impressions, clicks: 0, purchases, revenue });
  }

  // Purchases with zero impressions (rare) still earn a stats row.
  for (const [pid, buyers] of buyersByProduct) {
    if (!knownProducts.has(pid)) continue;
    if (rows.some((r) => r.product_id === pid)) continue;
    rows.push({
      product_id: pid,
      impressions: 0,
      clicks: 0,
      purchases: buyers.size,
      revenue: round2(revenueByProduct.get(pid) ?? 0),
    });
  }

  // Atomic replace of the instance's snapshot.
  await db.$transaction([
    db.product_surface_stats.deleteMany({ where: { shop_domain, surface, surface_ref } }),
    ...(rows.length > 0
      ? [
          db.product_surface_stats.createMany({
            data: rows.map((r) => ({
              ...r,
              shop_domain,
              surface,
              surface_ref,
              last_updated: new Date(),
            })),
          }),
        ]
      : []),
  ]);

  // Locked decision #2: purchases/window semantics derive from
  // computeAttribution(windowDays: 30). Called per instance refresh so the
  // arm-level numbers are authoritative and available to callers/verify.
  const attribution = await computeAttribution({
    shop_domain,
    surface,
    surface_ref,
    windowDays: SURFACE_STATS_WINDOW_DAYS,
  });

  return { shop_domain, surface, surface_ref, rows, attribution };
}
/** Start of the current UTC calendar day (used for the once-per-day gate). */
export function utcDayStart(date = new Date()): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Is this instance's stats fresh for the current UTC day? True iff at least
 * one product_surface_stats row for the instance was written at-or-after
 * today's UTC midnight.
 */
export async function isSurfaceStatsFresh(opts: {
  shop_domain: string;
  surface: string;
  surface_ref: string;
}): Promise<boolean> {
  const { shop_domain, surface, surface_ref } = opts;
  const newest = await db.product_surface_stats.findFirst({
    where: { shop_domain, surface, surface_ref },
    orderBy: { last_updated: "desc" },
    select: { last_updated: true },
  });
  return !!newest && newest.last_updated >= utcDayStart();
}

// In-process dedupe so concurrent first-of-day ranking requests share one
// rollup run instead of stampeding the DB.
const inFlight: Map<string, Promise<RefreshSurfaceStatsResult>> = new Map();

/**
 * Piggybacked daily cadence (locked #3): refresh the instance's
 * product_surface_stats exactly once per UTC day, triggered lazily by the
 * first ranking request of the day. Returns true when a refresh ran.
 */
export function ensureSurfaceStatsFresh(opts: {
  shop_domain: string;
  surface: string;
  surface_ref: string;
}): Promise<boolean> {
  const { shop_domain, surface, surface_ref } = opts;
  const key = `${shop_domain}|${surface}|${surface_ref}`;

  return (async () => {
    if (await isSurfaceStatsFresh({ shop_domain, surface, surface_ref })) {
      return false;
    }

    const existing = inFlight.get(key);
    if (existing) {
      await existing;
      return true;
    }

    const run = refreshSurfaceStats({ shop_domain, surface, surface_ref }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, run);
    await run;
    return true;
  })();
}