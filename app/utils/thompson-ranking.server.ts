/**
 * Live Thompson ranking wiring (server side).
 *
 * Consumes the two pure modules (thompson-sampling.ts and thompson-daily-cache.ts)
 * WITHOUT modifying them. Responsibilities:
 *
 * 1. CANDIDATE SET (locked #4): every product in the `products` table for the
 *    shop is a candidate. product_surface_stats rows (written by the daily
 *    rollup in product-surface-stats.server.ts) enrich candidates with their
 *    impressions/purchases; products WITHOUT a stats row still participate as
 *    zero-history candidates {impressions: 0, conversions: 0} so the
 *    uninformative prior protects/explores them rather than excluding them.
 *    Merchant control fields are honored at the pool boundary:
 *    is_excluded products are never candidates, and out-of-stock products
 *    (inventory_available <= 0) are never candidates. CAVEAT: no product/
 *    inventory sync exists in this app yet, so inventory_available sits at its
 *    schema default (0) until a sync populates it — the filter must be paired
 *    with that sync work, or it filters everything (flagged to the owner).
 *
 * 2. DAILY RANKING (locked #5): draw once per (visitor_id, surface, surface_ref)
 *    per UTC calendar day via getOrDrawDailyRanking, backed by a DURABLE store
 *    (the thompson_daily_rankings table) so a repeat request on the same day
 *    returns the identical cached order. The first request of the day calls
 *    getOrDrawDailyRanking, which invokes the provided draw callback
 *    (rankByThompsonSampling over the candidates).
 *
 * The store interface of thompson-daily-cache.ts is synchronous
 * (get/set on a Map-like). A live route cannot hold a DB connection inside a
 * synchronous get/set, so this module loads today's row into a Map, runs
 * getOrDrawDailyRanking synchronously, then persists any freshly drawn entry
 * back to Postgres. The cache-table row mirrors the buildDailyCacheKey grain
 * as separate columns (visitor_id, shop_domain, surface, surface_ref, date_utc).
 */

import db from "../db.server";
import { rankByThompsonSampling } from "./thompson-sampling";
import {
  getOrDrawDailyRanking,
  utcDateString,
  type DailyRankingStore,
} from "./thompson-daily-cache";

/**
 * Draw (or reuse) the day's ranked product order for one visitor on one
 * instance. `refreshStats`'s job is already done by the caller (the rank
 * route calls ensureSurfaceStatsFresh first); this function only reads.
 *
 * Returns the ranked product_ids for the day, plus `drew` (true when THIS call
 * produced the fresh draw).
 */
export async function drawOrReuseDailyRanking(opts: {
  visitor_id: string;
  shop_domain: string;
  surface: string;
  surface_ref: string;
  date_utc?: string;
  /** Search scoping: intersect the eligible pool with Shopify's own match set
   * (numeric ids from the client's /search.json fetch). Narrow-only. */
  allowed_product_ids?: string[];
}): Promise<{ ranking: string[]; drew: boolean; date_utc: string }> {
  const { visitor_id, shop_domain, surface, surface_ref } = opts;
  const dateUtc = opts.date_utc ?? utcDateString(new Date());

  // Durable store: load today's row (if any) into a Map so the pure module's
  // sync get/set contract is satisfied, then persist a fresh draw if produced.
  const store: DailyRankingStore = new Map();
  const key = `thompson_daily:${dateUtc}:${visitor_id}:${surface}:${surface_ref}`;

  const existing = await db.thompson_daily_rankings.findUnique({
    where: {
      visitor_id_shop_domain_surface_surface_ref_date_utc: {
        visitor_id,
        shop_domain,
        surface,
        surface_ref,
        date_utc: dateUtc,
      },
    },
  });
  if (existing && existing.ranking.length > 0) {
    store.set(key, { dateUtc, ranking: existing.ranking });
  }

  const candidates = await buildCandidates({ shop_domain, surface, surface_ref, allowed_product_ids: opts.allowed_product_ids });

  const result = getOrDrawDailyRanking(store, visitor_id, surface, surface_ref, dateUtc, () =>
    rankByThompsonSampling(candidates),
  );

  if (result.drew && result.ranking.length > 0) {
    await db.thompson_daily_rankings.upsert({
      where: {
        visitor_id_shop_domain_surface_surface_ref_date_utc: {
          visitor_id,
          shop_domain,
          surface,
          surface_ref,
          date_utc: dateUtc,
        },
      },
      create: {
        visitor_id,
        shop_domain,
        surface,
        surface_ref,
        date_utc: dateUtc,
        ranking: result.ranking,
      },
      update: { ranking: result.ranking },
    });
  }

  return { ranking: result.ranking, drew: result.drew, date_utc: dateUtc };
}

/** Concrete stats rows backing a candidate (product_surface_stats grain). */
export interface CandidateStats {
  product_id: string;
  impressions: number;
  conversions: number;
  /** Unit price from the products table; 0 = unpopulated (see the module's
   * fallback rules in thompson-sampling.ts — today this is ALWAYS the case). */
  price: number;
}

/**
 * Build the candidate pool for a (shop_domain, surface, surface_ref) instance:
 * every eligible `products` row for the shop (zero-history products included
 * with {impressions: 0, conversions: 0}), enriched by product_surface_stats
 * where a row exists. conversion = purchases (binary per-visitor, from the
 * rollup).
 *
 * Eligibility (merchant control fields, honored at the pool boundary):
 *   - is_excluded: merchant opted the product out of merchandising entirely.
 *   - inventory_available > 0: ranking an out-of-stock product up hurts
 *     conversion. NOTE: nothing in this app syncs inventory yet — until a
 *     product sync populates this column it is 0 by default and would filter
 *     every product. The future sync MUST set it (see module header caveat).
 *   - is_pinned / launch_window_end: intentionally NOT acted on — no code or
 *     UI anywhere assigns them meaning yet; inventing semantics here would
 *     guess at merchant intent (known deliberate gap).
 *   - allowed_product_ids (search surface only): intersect with Shopify's own
 *     /search.json match set passed by the client. Narrow-only — it can
 *     shrink the pool, never widen it. The daily cache grain is unchanged,
 *     so a repeat request the same day returns the same cached order even if
 *     Shopify's match set shifted (no relevance blending, by decision).
 */
export async function buildCandidates(opts: {
  shop_domain: string;
  surface: string;
  surface_ref: string;
  /** See doc above: search-surface scoping, intersect-only. */
  allowed_product_ids?: string[];
}): Promise<CandidateStats[]> {
  const { shop_domain, surface, surface_ref } = opts;

  const [products, statsRows] = await Promise.all([
    db.products.findMany({
      where: {
        shop_domain,
                is_excluded: false,
        // Exclude genuinely-out-of-stock products, but NOT untracked or
        // continue-selling ones (issue #7): always_available products are
        // legitimately purchasable at any inventory level (gift cards, digital
        // goods, "don't track inventory", continue-selling/oversell).
        OR: [
          { inventory_available: { gt: 0 } },
          { always_available: true },
        ],
        // Deleted-in-Shopify / draft / archived products are unrankable
        // (flagged by product-sync, never deleted locally — see module doc).
        deleted_at: null,
      },
      select: { product_id: true, price: true, always_available: true },
    }),
    db.product_surface_stats.findMany({
      where: { shop_domain, surface, surface_ref },
      select: { product_id: true, impressions: true, purchases: true },
    }),
  ]);

  const statsByProduct = new Map(statsRows.map((s) => [s.product_id, s]));

  // Search scoping: intersect (narrow-only) with Shopify's own match set.
  const allowed = opts.allowed_product_ids
    ? new Set(opts.allowed_product_ids)
    : null;
  const eligible = allowed
    ? products.filter((p) => allowed.has(p.product_id))
    : products;

  return eligible.map((p) => {
    const s = statsByProduct.get(p.product_id);
    return {
      product_id: p.product_id,
      impressions: s?.impressions ?? 0,
      conversions: s?.purchases ?? 0,
      // Prisma Decimal -> number. Today always 0 (no sync) — the ranking
      // module's fraction fallback keeps the live path pure-CVR until a
      // product sync populates real prices.
      price: Number(p.price),
    };
  });
}