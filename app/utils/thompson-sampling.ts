/**
 * Thompson Sampling ranking for collection/search merchandising.
 *
 * MODEL (design spec, locked):
 *   Each candidate product has an unknown true conversion rate on a specific
 *   (surface, surface_ref) instance. We model it with a Beta-Binomial posterior:
 *
 *     alpha = prior_alpha + conversions
 *     beta  = prior_beta  + (impressions - conversions)
 *
 *   A single draw s ~ Beta(alpha, beta) is a sample from the posterior over the
 *   product's conversion rate. Ranking candidates by one draw per product
 *   (highest draw first) IS the exploration mechanism: high-uncertainty products
 *   draw from wide distributions and get a realistic shot at the top, while
 *   confidence tightens as data accumulates. There is deliberately NO separate
 *   exploration bonus on top — sampling variance already provides it.
 *
 * REWARD SIGNAL: `conversions` must be counted as a BINARY reward (did this
 * impression lead to a purchase within the same 14-day attribution window used
 * in app/utils/attribution.server.ts) — NOT revenue-weighted. This module is
 * pure and takes the finished counts as inputs; the wiring that produces them
 * (a separate follow-up task) must reuse that window logic rather than
 * reimplementing it. DEFAULT_CONVERSION_WINDOW_DAYS is exported so wiring and
 * this module share the same default instead of hardcoding a magic number.
 *
 * RANKING KEY (cheap revenue weighting): candidates may carry an optional
 * `price` (sourced from the products table by the wiring). When priced data is
 * available, candidates are ranked by sampled_CVR * price (expected revenue per
 * impression) instead of sampled CVR alone — SAME Beta-Binomial model, same
 * draws, only the sort key changes. Safety valves:
 *   - If a meaningful fraction of candidates (see
 *     REVENUE_WEIGHT_FALLBACK_FRACTION) has no positive price, the whole call
 *     falls back to pure-CVR ranking with a loud structured warn
 *     (app/utils/logger.server.ts) — never ship a
 *     degenerate all-zero-weighted ranking (products.price defaults to 0 and
 *     no sync populates it yet, so this fallback is the live behavior today).
 *   - In the weighted path, a minority unpriced candidate gets a NEUTRAL
 *     weight of 1.0, not 0 — a zero multiplier would silently pin it to last
 *     place for missing data.
 *
 * This module contains NO database or Shopify imports and performs no I/O — it
 * is a pure, independently unit-testable scoring function.
 */

export interface ThompsonCandidate {
  /** Canonical numeric product id (string, as stored in the events table). */
  product_id: string | number;
  /** Total impressions served on this (surface, surface_ref) instance. */
  impressions: number;
  /** Binary conversions: distinct visitors who converted in the attribution window. */
  conversions: number;
  /**
   * Optional unit price (from the products table) for revenue weighting of the
   * RANKING KEY (not the model). Missing/non-positive = unpriced: see
   * rankByThompsonSampling's fallback and neutral-weight rules.
   */
  price?: number;
}

export interface ThompsonSampleOptions {
  /** prior_alpha — default 1 (uninformative), configurable for post-pilot tuning. */
  priorAlpha?: number;
  /** prior_beta — default 1 (uninformative), configurable for post-pilot tuning. */
  priorBeta?: number;
  /** Injectable uniform [0,1) RNG, for deterministic tests and simulations. */
  rng?: () => number;
}

/** Uninformative Beta(1,1) prior; may be tuned after real pilot data. */
export const DEFAULT_PRIOR_ALPHA = 1;
export const DEFAULT_PRIOR_BETA = 1;

import { logWarn } from "./logger.server.ts";

/**
 * Revenue-weighting fallback trigger: if MORE than this fraction of candidates
 * in a ranking call lacks a positive price, the call falls back to pure-CVR
 * ranking (with a structured warn) instead of producing a degenerate
 * all-zero-weighted order. products.price defaults to 0 and nothing syncs it
 * yet, so with current data EVERY call takes this fallback — revenue weighting
 * only activates once a product sync populates real prices.
 */
export const REVENUE_WEIGHT_FALLBACK_FRACTION = 0.5;

/**
 * Process-level flag so the fallback warning fires ONCE, not once per ranking
 * call (a shop with many visitors would otherwise spam identical warnings all
 * day — the condition doesn't change between calls). Reset via
 * resetFallbackWarningForTests() in unit tests.
 */
let fallbackWarningEmitted = false;

/** Test hook: re-arm the one-time fallback warning. */
export function resetFallbackWarningForTests(): void {
  fallbackWarningEmitted = false;
}

/**
 * Conversion-labeling window (days) shared with app/utils/attribution.server.ts.
 * This module never applies it itself — it documents the contract the wiring
 * must use when counting `conversions` for a candidate.
 */
export const DEFAULT_CONVERSION_WINDOW_DAYS = 14;

export interface BetaParams {
  alpha: number;
  beta: number;
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`ThompsonCandidate.${name} must be a finite non-negative number; got ${value}`);
  }
}

/**
 * Compute the Beta-Binomial posterior parameters:
 *   alpha = prior_alpha + conversions
 *   beta  = prior_beta  + (impressions - conversions)
 *
 * Throws on impossible data (conversions > impressions) — this module is pure and
 * fails loudly rather than silently scoring a corrupted row.
 */
export function posteriorParams(
  candidate: ThompsonCandidate,
  options: ThompsonSampleOptions = {},
): BetaParams {
  const priorAlpha = options.priorAlpha ?? DEFAULT_PRIOR_ALPHA;
  const priorBeta = options.priorBeta ?? DEFAULT_PRIOR_BETA;
  const { impressions, conversions } = candidate;

  assertNonNegative(impressions, "impressions");
  assertNonNegative(conversions, "conversions");
  if (conversions > impressions) {
    throw new RangeError(
      `ThompsonCandidate.conversions (${conversions}) exceeds impressions (${impressions}) for ${candidate.product_id}; impossible observation`,
    );
  }
  if (!Number.isFinite(priorAlpha) || priorAlpha <= 0 || !Number.isFinite(priorBeta) || priorBeta <= 0) {
    throw new RangeError(`priors must be positive finite numbers; got priorAlpha=${priorAlpha}, priorBeta=${priorBeta}`);
  }

  return {
    alpha: priorAlpha + conversions,
    beta: priorBeta + (impressions - conversions),
  };
}
/**
 * Draw a single feed-forward Beta(alpha, beta) sample: ratio of two Gamma
 * variates (Gamma(alpha)/(Gamma(alpha)+Gamma(beta))). Gamma uses Marsaglia &
 * Tsang (2000) for shape >= 1 with the standard boost Gamma(k) = U^(1/k) Gamma(k+1)
 * for k < 1, so it stays numerically sane even for large impression counts
 * (beta in the thousands) and non-integer configured priors.
 */
export function sampleBeta(alpha: number, beta: number, rng: () => number = Math.random): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || !Number.isFinite(beta) || beta <= 0) {
    throw new RangeError(`sampleBeta requires alpha,beta > 0; got alpha=${alpha}, beta=${beta}`);
  }
  const g1 = gammaSample(alpha, rng);
  const g2 = gammaSample(beta, rng);
  return g1 / (g1 + g2);
}

/**
 * Draw one posterior sample for a single candidate product (zero history draws
 * from the raw prior). Primarily useful for tests and pairwise analysis; the
 * ranking entry point is rankByThompsonSampling.
 */
export function sampleBetaForCandidate(
  candidate: ThompsonCandidate,
  options: ThompsonSampleOptions = {},
): number {
  const { alpha, beta } = posteriorParams(candidate, options);
  return sampleBeta(alpha, beta, options.rng ?? Math.random);
}

/**
 * Rank candidates by Thompson Sampling: draw ONE sample from each candidate's
 * Beta(alpha, beta) posterior. The sort key is the sampled value weighted by
 * price (expected revenue per impression) when price data is usable:
 *
 *   - priced minority (unpriced fraction <= REVENUE_WEIGHT_FALLBACK_FRACTION):
 *     sort by sampled_CVR * price, with unpriced candidates weighted 1.0
 *     (neutral — missing data must not zero a product out of the ranking).
 *   - unpriced majority (> the fallback fraction): loud structured warn and sort
 *     by raw sampled_CVR — the exact pre-weighting behavior. This is the live
 *     path today (no price sync exists).
 *
 * The MODEL is untouched in both paths: identical posterior, identical draws,
 * identical exploration. Returns the ranked product_id list (strings).
 * Candidates are never mutated.
 */
export function rankByThompsonSampling(
  candidates: ThompsonCandidate[],
  options: ThompsonSampleOptions = {},
): string[] {
  const rng = options.rng ?? Math.random;
  const seen = new Set<string>();
  const sampled = candidates.map((candidate) => {
    const productId = String(candidate.product_id);
    if (seen.has(productId)) {
      throw new Error(`duplicate product_id in candidates: ${productId}`);
    }
    seen.add(productId);
    const { alpha, beta } = posteriorParams(candidate, options);
    return {
      productId,
      sample: sampleBeta(alpha, beta, rng),
      // Neutral 1.0 weight for unpriced candidates (weighted path only).
      priceWeight:
        typeof candidate.price === "number" &&
        Number.isFinite(candidate.price) &&
        candidate.price > 0
          ? candidate.price
          : 1,
    };
  });
  if (sampled.length === 0) {
    return [];
  }

  const unpricedCount = candidates.filter(
    (c) => !(typeof c.price === "number" && Number.isFinite(c.price) && c.price > 0),
  ).length;
  const unpricedFraction = unpricedCount / sampled.length;

  if (unpricedFraction > REVENUE_WEIGHT_FALLBACK_FRACTION) {
    if (!fallbackWarningEmitted) {
      fallbackWarningEmitted = true;
      logWarn(
        { module: "thompson-sampling" },
        `[thompson-sampling] revenue weighting SKIPPED: ${unpricedCount}/${sampled.length}` +
          ` candidates have no positive price (> ${REVENUE_WEIGHT_FALLBACK_FRACTION});` +
          ` ranking by sampled CVR only (products.price unpopulated? sync missing?)` +
          ` — further identical warnings suppressed for this process`,
      );
    }
    sampled.sort((a, b) => b.sample - a.sample);
    return sampled.map(({ productId }) => productId);
  }

  // Weighted path: price weight already defaults to 1.0 for unpriced candidates.
  sampled.sort(
    (a, b) => b.sample * b.priceWeight - a.sample * a.priceWeight,
  );
  return sampled.map(({ productId }) => productId);
}

/** Standard normal variate via Box-Muller (Marsaglia-Tsang depends on it). */
function normalSample(rng: () => number): number {
  let u = 0;
  do {
    u = rng();
  } while (u <= 0 || u >= 1); // keep log() and the fallback math well-defined
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) variate; Marsaglia & Tsang (2000), shape >= 1. */
function gammaSample(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost trick: Gamma(k) ~= U^(1/k) * Gamma(k+1), U ~ Uniform(0,1).
    return gammaSample(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = normalSample(rng);
    const v = Math.pow(1 + c * z, 3);
    if (v <= 0) continue;
    const u = rng();
    // Cheap-accept test first; fall back to the full log test only when needed.
    if (u < 1 - 0.0331 * Math.pow(z, 4)) return d * v;
    if (Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v;
  }
}