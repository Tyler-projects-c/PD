/**
 * Unit tests for the Thompson Sampling ranking module
 * (app/utils/thompson-sampling.ts).
 *
 * Run: node --test scripts/test-thompson-sampling.mjs
 * Requires Node >= 22.12 (native TypeScript type-stripping).
 *
 * Covers the locked design contract:
 *   - alpha/beta posterior update math vs hand-calculated values
 *   - impossibility validation (conversions > impressions, bad priors)
 *   - zero-history candidates draw a wide/uncertain Beta(1,1) — never
 *     deterministically top or bottom
 *   - sampling-only exploration: a no-data product beats an established product
 *     at the statistically expected rate (not just "sometimes")
 *   - configurable priors shift the un-informed starting point
 *   - ranking shape (every candidate exactly once, stable ties, determinism)
 *
 * All statistical bounds are computed closed-form below (e.g. P(U > p) = 1 - E[p])
 * and the harness is seeded, so failures would mean a real bug, not noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  REVENUE_WEIGHT_FALLBACK_FRACTION,
  resetFallbackWarningForTests,
  posteriorParams,
  sampleBeta,
  sampleBetaForCandidate,
  rankByThompsonSampling,
} from "../app/utils/thompson-sampling.ts";

/** Deterministic PRNG (mulberry32) so statistical tests are reproducible. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("defaults are the uninformative Beta(1,1) prior, exposed as constants", () => {
  assert.equal(DEFAULT_PRIOR_ALPHA, 1);
  assert.equal(DEFAULT_PRIOR_BETA, 1);
});

test("posteriorParams: alpha/beta update math against hand-calculated values", () => {
  // alpha = prior_alpha + conversions ; beta = prior_beta + (impressions - conversions)
  assert.deepEqual(
    posteriorParams({ product_id: "p", impressions: 10, conversions: 2 }),
    { alpha: 3, beta: 9 },
  );
  // custom priors: alpha = 2 + 2 = 4 ; beta = 3 + (10 - 2) = 11
  assert.deepEqual(
    posteriorParams({ product_id: "p", impressions: 10, conversions: 2 }, { priorAlpha: 2, priorBeta: 3 }),
    { alpha: 4, beta: 11 },
  );
  // zero history -> exactly the prior
  assert.deepEqual(
    posteriorParams({ product_id: "p", impressions: 0, conversions: 0 }),
    { alpha: 1, beta: 1 },
  );
  // every impression converted -> beta stays at the prior
  assert.deepEqual(
    posteriorParams({ product_id: "p", impressions: 5, conversions: 5 }),
    { alpha: 6, beta: 1 },
  );
});

test("posteriorParams: rejects impossible data instead of silently scoring it", () => {
  assert.throws(() => posteriorParams({ product_id: "p", impressions: 3, conversions: 5 }), /conversions/);
  assert.throws(() => posteriorParams({ product_id: "p", impressions: -1, conversions: 0 }), /impressions/);
  assert.throws(() => posteriorParams({ product_id: "p", impressions: 2, conversions: 0 }, { priorAlpha: 0 }), /prior/);
  assert.throws(() => posteriorParams({ product_id: "p", impressions: 2, conversions: 0 }, { priorBeta: -1 }), /prior/);
});

test("zero-history product: wide/uncertain Beta(1,1), not deterministically top or bottom", () => {
  const n = 100_000;
  const rng = mulberry32(1234);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = sampleBetaForCandidate({ product_id: "new", impressions: 0, conversions: 0 }, { rng });
    sum += s;
    sumSq += s * s;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `zero-history sample mean ${mean} ~= 0.5 (wide/uniform)`);
  assert.ok(Math.abs(variance - 1 / 12) < 0.01, `zero-history sample variance ${variance} ~= 1/12`);

  // Against a veteran product it must BOTH win sometimes and lose sometimes —
  // a wide, uncertain distribution is neither pinned top nor pinned bottom.
  // (Theory: win rate = 1 - E[p] = 79.9%, so thousands of losses are certain.)
  const veteran = { product_id: "veteran", impressions: 500, conversions: 100 }; // Beta(101,401)
  const trials = 20_000;
  const rng2 = mulberry32(99);
  let newFirst = 0;
  for (let i = 0; i < trials; i++) {
    const order = rankByThompsonSampling([veteran, { product_id: "new", impressions: 0, conversions: 0 }], { rng: rng2 });
    if (order[0] === "new") newFirst += 1;
  }
  assert.ok(
    newFirst > 10_000 && trials - newFirst > 1_000,
    `both outcomes occurred (new-first ${newFirst}/${trials}) — never a fixed winner`,
  );
});

test("sampling-only exploration: no-data product wins at the statistically expected rate", () => {
  // Veteran Beta(101,401): E[p] = 101/502 = 0.2012…
  // New Beta(1,1) = U(0,1). P(U beats p) = E[1 - p] = 1 - E[p], exactly.
  const veteran = { product_id: "veteran", impressions: 500, conversions: 100 };
  const newbie = { product_id: "newbie", impressions: 0, conversions: 0 };
  const expected = 1 - 101 / 502;

  const trials = 20_000;
  const rng = mulberry32(7);
  let newFirst = 0;
  for (let i = 0; i < trials; i++) {
    const order = rankByThompsonSampling([veteran, newbie], { rng });
    if (order[0] === "newbie") newFirst += 1;
  }
  const rate = newFirst / trials;
  assert.ok(
    Math.abs(rate - expected) < 0.03,
    `no-data win rate ${rate.toFixed(4)} within ±0.03 of expected ${expected.toFixed(4)}`,
  );
});
test("a convincing veteran still only ranks first vs two no-data products ~E[p^2] of the time", () => {
  // Champion Beta(401, 601): mu=0.4. Wins against TWO independents iff
  // p > max(u1, u2) -> P = E[p^2] = Var + mu^2 (closed-form Beta property).
  const champ = { product_id: "veteran", impressions: 1000, conversions: 400 };
  const alpha = 401;
  const beta = 601;
  const mu = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const expected = variance + mu * mu;

  const noData = [
    { product_id: "n1", impressions: 0, conversions: 0 },
    { product_id: "n2", impressions: 0, conversions: 0 },
  ];
  const trials = 30_000;
  const rng = mulberry32(31_337);
  let championFirst = 0;
  for (let i = 0; i < trials; i++) {
    const order = rankByThompsonSampling([champ, ...noData], { rng });
    if (order[0] === "veteran") championFirst += 1;
  }
  const rate = championFirst / trials;
  assert.ok(
    Math.abs(rate - expected) < 0.03,
    `veteran-first rate ${rate.toFixed(4)} within ±0.03 of closed-form ${expected.toFixed(4)}`,
  );
});

test("configurable priors shift the un-informed starting point (no magic numbers)", () => {
  // Beta(2, 8) zero-history prior: pessimistic starting mean 0.2. The mechanism
  // is unchanged — only the un-informed baseline moves.
  const n = 50_000;
  const rng = mulberry32(2024);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sampleBetaForCandidate(
      { product_id: "new", impressions: 0, conversions: 0 },
      { priorAlpha: 2, priorBeta: 8, rng },
    );
  }
  assert.ok(Math.abs(sum / n - 0.2) < 0.02, `pessimistic prior sample mean ${(sum / n).toFixed(4)} ~= 0.2`);
});

test("rankByThompsonSampling returns a complete ranking; ties are stable; runs are deterministic", () => {
  // Constant draw -> every candidate ties -> stable sort preserves input order.
  const ids = ["a", "b", "c"];
  const candidates = ids.map((product_id, i) => ({ product_id, impressions: i * 10, conversions: i }));
  assert.deepEqual(rankByThompsonSampling(candidates, { rng: () => 0.5 }), ids);

  // Edge cases.
  assert.deepEqual(rankByThompsonSampling([]), []);
  assert.deepEqual(rankByThompsonSampling([{ product_id: "solo", impressions: 3, conversions: 1 }]), ["solo"]);

  // Same seed -> identical ranking.
  const mk = () => [
    { product_id: "p1", impressions: 10, conversions: 1 },
    { product_id: "p2", impressions: 40, conversions: 8 },
    { product_id: "p3", impressions: 5, conversions: 0 },
  ];
  assert.deepEqual(
    rankByThompsonSampling(mk(), { rng: mulberry32(555) }),
    rankByThompsonSampling(mk(), { rng: mulberry32(555) }),
  );

  // Duplicates are rejected loudly.
  assert.throws(
    () =>
      rankByThompsonSampling(
        [
          { product_id: "dup", impressions: 1, conversions: 0 },
          { product_id: "dup", impressions: 2, conversions: 1 },
        ],
        { rng: mulberry32(1) },
      ),
    /duplicate/,
  );
});

test("sampleBeta is a valid sampler: Beta(1,1) as Uniform, Beta(2,5) mean = 2/7", () => {
  const n = 100_000;
  const rngA = mulberry32(8);
  let sumA = 0;
  for (let i = 0; i < n; i++) sumA += sampleBeta(1, 1, rngA);
  assert.ok(Math.abs(sumA / n - 0.5) < 0.01, `Beta(1,1) mean ${(sumA / n).toFixed(4)} ~= 0.5`);

  const rngB = mulberry32(9);
  let sumB = 0;
  for (let i = 0; i < n; i++) sumB += sampleBeta(2, 5, rngB);
  assert.ok(Math.abs(sumB / n - 2 / 7) < 0.01, `Beta(2,5) mean ${(sumB / n).toFixed(4)} ~= 2/7`);

  assert.throws(() => sampleBeta(0, 1), /alpha,beta > 0/);
  assert.throws(() => sampleBeta(1, -2), /alpha,beta > 0/);
});

// ---------------------------------------------------------------------------
// Revenue weighting (ranking key = sampled_CVR * price; model untouched)
// ---------------------------------------------------------------------------

test("revenue weighting: ranking key is sampled_CVR * price, disagreeing with pure CVR", () => {
  // Tight posteriors (1000 impressions each) so sampled CVR ~= true CVR:
  //   cheap:     cvr 0.40 * $10  = $4.00 expected revenue per impression
  //   expensive: cvr 0.10 * $100 = $10.00 expected revenue per impression
  // Pure CVR ranking picks "cheap"; revenue-weighted ranking picks
  // "expensive". Same seeds -> identical underlying Beta draws, so the flip
  // is purely the ranking-key change, not sampling noise.
  const mkWithPrice = () => [
    { product_id: "cheap", impressions: 1000, conversions: 400, price: 10 },
    { product_id: "expensive", impressions: 1000, conversions: 100, price: 100 },
  ];
  const mkWithoutPrice = () => [
    { product_id: "cheap", impressions: 1000, conversions: 400 },
    { product_id: "expensive", impressions: 1000, conversions: 100 },
  ];

  const trials = 5_000;
  let weightedPicksExpensive = 0;
  let purePicksCheap = 0;
  for (let i = 0; i < trials; i++) {
    const seed = 900_000 + i;
    if (rankByThompsonSampling(mkWithPrice(), { rng: mulberry32(seed) })[0] === "expensive") {
      weightedPicksExpensive += 1;
    }
    if (rankByThompsonSampling(mkWithoutPrice(), { rng: mulberry32(seed) })[0] === "cheap") {
      purePicksCheap += 1;
    }
  }
  assert.ok(
    weightedPicksExpensive / trials > 0.99,
    `revenue-weighted ranking picks the higher-revenue product ${(weightedPicksExpensive / trials * 100).toFixed(2)}% (need > 99%)`,
  );
  assert.ok(
    purePicksCheap / trials > 0.99,
    `pure-CVR ranking picks the higher-CVR product ${(purePicksCheap / trials * 100).toFixed(2)}% (need > 99%) — proves the two keys disagree`,
  );
});

test("weighted path: unpriced MINORITY gets a neutral 1.0 weight, not zero suppression", () => {
  // 1 of 2 unpriced -> fraction 0.5 is NOT > 0.5 -> weighted path stays active.
  //   priced-low:   cvr 0.04 * $5 = 0.20
  //   unpriced-hot: cvr 0.40 * (neutral 1.0) = 0.40  -> must win
  // With zero suppression the unpriced product would lose 100% of the time.
  const priced = { product_id: "priced-low", impressions: 1000, conversions: 40, price: 5 };
  const unpriced = { product_id: "unpriced-hot", impressions: 1000, conversions: 400 }; // no price field
  const trials = 5_000;
  let unpricedFirst = 0;
  for (let i = 0; i < trials; i++) {
    const order = rankByThompsonSampling([priced, unpriced], { rng: mulberry32(700_000 + i) });
    if (order[0] === "unpriced-hot") unpricedFirst += 1;
  }
  assert.ok(
    unpricedFirst / trials > 0.99,
    `unpriced minority candidate ranked first ${(unpricedFirst / trials * 100).toFixed(2)}% (neutral weight; need > 99%)`,
  );
});

test("zero-price MAJORITY falls back to pure-CVR ranking with a loud warning (no crash)", () => {
  // 2 of 3 unpriced -> fraction 2/3 > 0.5 -> fallback: identical output to a
  // fully price-less ranking under the same seed, plus a (one-time) warn.
  assert.equal(REVENUE_WEIGHT_FALLBACK_FRACTION, 0.5);
  resetFallbackWarningForTests();
  const a = { product_id: "a", impressions: 100, conversions: 30, price: 50 };
  const b = { product_id: "b", impressions: 100, conversions: 10 }; // missing price
  const c = { product_id: "c", impressions: 100, conversions: 20, price: 0 };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  let fallbackOrder;
  let pricelessOrder;
  try {
    fallbackOrder = rankByThompsonSampling([a, b, c], { rng: mulberry32(4242) });
    pricelessOrder = rankByThompsonSampling(
      [
        { product_id: "a", impressions: 100, conversions: 30 },
        { product_id: "b", impressions: 100, conversions: 10 },
        { product_id: "c", impressions: 100, conversions: 20 },
      ],
      { rng: mulberry32(4242) },
    );
    // A fully unpriced single-candidate call must not crash and must return
    // the candidate — this is the live path today (no price sync exists).
    const solo = rankByThompsonSampling(
      [{ product_id: "solo-unpriced", impressions: 3, conversions: 1 }],
      { rng: mulberry32(99) },
    );
    assert.deepEqual(solo, ["solo-unpriced"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(fallbackOrder, pricelessOrder);
  // One-time dedupe: exactly ONE warning for these three fallback calls.
  assert.equal(warnings.length, 1, `expected exactly one deduped console.warn (got ${warnings.length})`);
  assert.match(warnings[0], /revenue weighting SKIPPED/);
  assert.match(warnings[0], /2\/3/);
  resetFallbackWarningForTests();
});
