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
 * Beta(alpha, beta) posterior and sort descending by sampled value. A higher
 * draw means a higher posterior-probability that the product's true rate
 * outperforms the others' — displayed first. Returns the ranked product_id
 * list (strings). Candidates are never mutated.
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
    return { productId, sample: sampleBeta(alpha, beta, rng) };
  });
  // Descending posterior sample. Array.prototype.sort is stable (ES2019+), so
  // equal draws keep input order — an acceptable tie-break for a random scoring.
  sampled.sort((a, b) => b.sample - a.sample);
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