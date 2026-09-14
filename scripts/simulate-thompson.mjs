/**
 * Thompson Sampling simulation — proves convergence + late-entrant exploration
 * using the REAL ranking module (app/utils/thompson-sampling.ts).
 *
 * Run: node scripts/simulate-thompson.mjs            (default seed 42)
 *      node scripts/simulate-thompson.mjs --seed=7
 *
 * Model, exactly like production would count it:
 *   - each round = one day on a (surface, surface_ref) instance
 *   - rank ALL products with one posterior draw each (real module)
 *   - the top SHOWN_K are "shown" and receive DAILY_IMPRESSIONS impressions
 *   - conversions ~ Binomial(impressions, TRUE product CVR) — binary reward
 *
 * Phase A: 5 incumbents with known CVRs — the ranking must converge toward the
 *          true best performer over time.
 * Phase B: a brand-new product (no history, CVR higher than the incumbent best)
 *          enters late among established bestsellers — it must be shown at a
 *          non-trivial rate EARLY (Thompson explores: wide Beta(1,1) draws beat
 *          narrow incumbent posteriors often), then converge to dominance.
 * Phase C: revenue-weighted ranking key (sampled_CVR * price, all candidates
 *          priced) — the best-REVENUE product must lead even though a
 *          different product has the best CVR.
 * Phase D: a zero-history, best-revenue late entrant must still be explored
 *          fairly and converge to dominance under the weighted objective.
 *
 * Seeded and deterministic: the printed numbers are stable across runs.
 */
import { rankByThompsonSampling } from "../app/utils/thompson-sampling.ts";

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

function binomial(n, p) {
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k += 1;
  return k;
}

const seed = Number((process.argv.find((a) => a.startsWith("--seed=")) || "--seed=42").slice(7));
const rng = mulberry32(seed);

const SHOWN_K = 3;
const IMPRESSIONS_PER_SHOWN = 60; // impressions per shown product, per round
const ROUNDS_A = 300; // incumbents learn
const ROUNDS_B = 200; // late entrant

const INCUMBENTS = [
  { product_id: "snowboard-alpha", cvr: 0.08 },
  { product_id: "snowboard-bravo", cvr: 0.06 },
  { product_id: "snowboard-charlie", cvr: 0.045 },
  { product_id: "snowboard-delta", cvr: 0.03 },
  { product_id: "snowboard-echo", cvr: 0.02 },
];
const LATE = { product_id: "snowboard-newcomer", cvr: 0.1 }; // better than incumbent best

const state = new Map(INCUMBENTS.map((p) => [p.product_id, { cvr: p.cvr, impressions: 0, conversions: 0 }]));
const totalRounds = ROUNDS_A + ROUNDS_B;
const orderHistory = new Array(totalRounds);
const topKHistory = new Array(totalRounds);

function step(round) {
  const candidates = [...state.entries()].map(([product_id, s]) => ({
    product_id,
    impressions: s.impressions,
    conversions: s.conversions,
  }));
  const order = rankByThompsonSampling(candidates, { rng });
  const shown = order.slice(0, SHOWN_K);
  for (const pid of shown) {
    const s = state.get(pid);
    s.impressions += IMPRESSIONS_PER_SHOWN;
    s.conversions += binomial(IMPRESSIONS_PER_SHOWN, s.cvr);
  }
  orderHistory[round] = order;
  topKHistory[round] = shown;
}

for (let round = 0; round < ROUNDS_A; round++) step(round); // Phase A

state.set(LATE.product_id, { cvr: LATE.cvr, impressions: 0, conversions: 0 }); // Phase B entry
for (let round = ROUNDS_A; round < totalRounds; round++) step(round);

// ---- metrics -------------------------------------------------------------
function meanRank(productId, rounds) {
  let total = 0;
  for (const r of rounds) total += orderHistory[r].indexOf(productId) + 1;
  return total / rounds.length;
}
function top1Rate(productId, rounds) {
  let wins = 0;
  for (const r of rounds) if (orderHistory[r][0] === productId) wins += 1;
  return wins / rounds.length;
}
function shownRate(productId, rounds) {
  let shown = 0;
  for (const r of rounds) if (topKHistory[r].includes(productId)) shown += 1;
  return shown / rounds.length;
}
const last100A = Array.from({ length: 100 }, (_, i) => ROUNDS_A - 100 + i);
const first40B = Array.from({ length: 40 }, (_, i) => ROUNDS_A + i);
const last100B = Array.from({ length: 100 }, (_, i) => totalRounds - 100 + i);

const pad = (v, w) => String(v).padStart(w);
console.log(`Thompson sampling simulation (seed=${seed})`);
console.log(`  incumbents learn: ${ROUNDS_A} rounds | late entrant: ${ROUNDS_B} rounds | top-K shown: ${SHOWN_K} | ${IMPRESSIONS_PER_SHOWN} impressions/day per shown product\n`);

console.log("== Phase A: incumbents -> convergence toward true best (alpha=0.08) ==");
for (const p of INCUMBENTS) {
  const s = state.get(p.product_id);
  const mu = (1 + s.conversions) / (2 + s.impressions); // alpha/(alpha+beta) = (1+c)/(2+i)
  console.log(
    `${p.product_id.padEnd(20)} cvr=${p.cvr.toFixed(3)}  imp=${pad(s.impressions, 6)}  conv=${pad(s.conversions, 5)}` +
      `  posterior_mean=${pad(mu.toFixed(5), 9)}  top1_last100=${pad((top1Rate(p.product_id, last100A) * 100).toFixed(1) + "%", 9)}` +
      `  mean_rank_last100=${meanRank(p.product_id, last100A).toFixed(2)}`,
  );
}

console.log("\n== Phase B: late entrant (cvr=0.10) among established bestsellers ==");
const late = state.get(LATE.product_id);
const lateMu = (1 + late.conversions) / (2 + late.impressions); // alpha/(alpha+beta)
console.log(`  newcomer (#snowboard-newcomer) imp=${late.impressions} conv=${late.conversions} posterior_mean=${lateMu.toFixed(5)}`);
console.log(`  newcomer top1  first 40 rounds: ${(top1Rate(LATE.product_id, first40B) * 100).toFixed(1)}%`);
console.log(`  newcomer shown first 40 rounds: ${(shownRate(LATE.product_id, first40B) * 100).toFixed(1)}%  (top-3 of 6)`);
console.log(`  newcomer top1  last 100 rounds: ${(top1Rate(LATE.product_id, last100B) * 100).toFixed(1)}%`);
const incBest = INCUMBENTS[0];
console.log(
  `  incumbent alpha top1 last 100:       ${(top1Rate(incBest.product_id, last100B) * 100).toFixed(1)}%` +
    `  (expected to fade: the newcomer is genuinely better)`,
);
// ---- assertions -----------------------------------------------------------
const failures = [];
const aTop1 = top1Rate(INCUMBENTS[0].product_id, last100A);
if (aTop1 < 0.9) {
  failures.push(`Phase A: true best (alpha) top-1 in last 100 rounds was ${(aTop1 * 100).toFixed(1)}% (need >= 90%)`);
}
for (const p of INCUMBENTS.slice(1)) {
  const alphaRank = meanRank(INCUMBENTS[0].product_id, last100A);
  const otherRank = meanRank(p.product_id, last100A);
  if (!(alphaRank < otherRank)) {
    failures.push(`Phase A: alpha's mean rank (${alphaRank.toFixed(2)}) not strictly better than ${p.product_id} (${otherRank.toFixed(2)})`);
  }
}
const lateFirst40 = top1Rate(LATE.product_id, first40B);
const lateShown40 = shownRate(LATE.product_id, first40B);
if (lateFirst40 < 0.55) {
  failures.push(`Phase B: newcomer top-1 in first 40 rounds was ${(lateFirst40 * 100).toFixed(1)}% (need >= 55%)`);
}
if (lateShown40 < 0.9) {
  failures.push(`Phase B: newcomer shown in first 40 rounds was ${(lateShown40 * 100).toFixed(1)}% (need >= 90%)`);
}
const lateLast100 = top1Rate(LATE.product_id, last100B);
if (lateLast100 < 0.9) {
  failures.push(`Phase B: newcomer top-1 in last 100 rounds was ${(lateLast100 * 100).toFixed(1)}% (need >= 90%)`);
}

// ---- Phase C/D: revenue-weighted objective (sampled_CVR * price) ----------
// Same model, same draws — only the ranking key changes. Incumbent CVRs are
// chosen so the best-CVR product is NOT the best-revenue product:
//   budget-buster  cvr 0.10 * $10  = 1.0/impression  <- best CVR
//   mid-range      cvr 0.06 * $40  = 2.4
//   premium-pick   cvr 0.03 * $150 = 4.5            <- true best REVENUE
//   cheap-filler   cvr 0.05 * $8   = 0.4
// Phase D: a zero-history late entrant with the best true revenue
//   luxury-newcomer cvr 0.04 * $200 = 8.0           <- eventual best
const PRICE_INCUMBENTS = [
  { product_id: "budget-buster", cvr: 0.1, price: 10 },
  { product_id: "mid-range", cvr: 0.06, price: 40 },
  { product_id: "premium-pick", cvr: 0.03, price: 150 },
  { product_id: "cheap-filler", cvr: 0.05, price: 8 },
];
const PRICE_LATE = { product_id: "luxury-newcomer", cvr: 0.04, price: 200 };
const PRICE_ROUNDS_LEARN = 300;
const PRICE_ROUNDS_LATE = 200;

const priceState = new Map(
  PRICE_INCUMBENTS.map((p) => [p.product_id, { cvr: p.cvr, price: p.price, impressions: 0, conversions: 0 }]),
);
const priceTotalRounds = PRICE_ROUNDS_LEARN + PRICE_ROUNDS_LATE;
const priceOrderHistory = new Array(priceTotalRounds);
const priceTopKHistory = new Array(priceTotalRounds);

function priceStep(round) {
  const candidates = [...priceState.entries()].map(([product_id, s]) => ({
    product_id,
    impressions: s.impressions,
    conversions: s.conversions,
    price: s.price, // revenue-weighted ranking key (all candidates priced)
  }));
  const order = rankByThompsonSampling(candidates, { rng });
  const shown = order.slice(0, SHOWN_K);
  for (const pid of shown) {
    const s = priceState.get(pid);
    s.impressions += IMPRESSIONS_PER_SHOWN;
    s.conversions += binomial(IMPRESSIONS_PER_SHOWN, s.cvr);
  }
  priceOrderHistory[round] = order;
  priceTopKHistory[round] = shown;
}

for (let round = 0; round < PRICE_ROUNDS_LEARN; round++) priceStep(round); // Phase C
priceState.set(PRICE_LATE.product_id, {
  cvr: PRICE_LATE.cvr,
  price: PRICE_LATE.price,
  impressions: 0,
  conversions: 0,
}); // Phase D entry (zero history, priced)
for (let round = PRICE_ROUNDS_LEARN; round < priceTotalRounds; round++) priceStep(round);

function priceMeanRank(productId, rounds) {
  let total = 0;
  for (const r of rounds) total += priceOrderHistory[r].indexOf(productId) + 1;
  return total / rounds.length;
}
function priceTop1Rate(productId, rounds) {
  let shown = 0;
  for (const r of rounds) if (priceOrderHistory[r][0] === productId) shown += 1;
  return shown / rounds.length;
}
function priceShownRate(productId, rounds) {
  let shown = 0;
  for (const r of rounds) if (priceTopKHistory[r].includes(productId)) shown += 1;
  return shown / rounds.length;
}

const priceLast100Learn = Array.from({ length: 100 }, (_, i) => PRICE_ROUNDS_LEARN - 100 + i);
const priceFirst40Late = Array.from({ length: 40 }, (_, i) => PRICE_ROUNDS_LEARN + i);
const priceLast100Late = Array.from({ length: 100 }, (_, i) => priceTotalRounds - 100 + i);

console.log("\n== Phase C: revenue-weighted objective (all candidates priced) ==");
for (const p of PRICE_INCUMBENTS) {
  const s = priceState.get(p.product_id);
  console.log(
    `${p.product_id.padEnd(20)} cvr=${p.cvr.toFixed(3)}  price=$${pad(p.price, 4)}  rev/imp=${pad((p.cvr * p.price).toFixed(2), 6)}` +
      `  imp=${pad(s.impressions, 6)}  conv=${pad(s.conversions, 5)}` +
      `  top1_last100_learn=${pad((priceTop1Rate(p.product_id, priceLast100Learn) * 100).toFixed(1) + "%", 9)}` +
      `  mean_rank_last100_learn=${priceMeanRank(p.product_id, priceLast100Learn).toFixed(2)}`,
  );
}
console.log(
  "  (premium-pick has the WORST CVR but the best revenue/impression — it must lead," +
    "\n   while budget-buster, the CVR champion, must not)",
);

const premiumTop1 = priceTop1Rate("premium-pick", priceLast100Learn);
if (premiumTop1 < 0.85) {
  failures.push(`Phase C: premium-pick (best REVENUE) top-1 in last 100 learn rounds was ${(premiumTop1 * 100).toFixed(1)}% (need >= 85%)`);
}
const premiumRank = priceMeanRank("premium-pick", priceLast100Learn);
const budgetRank = priceMeanRank("budget-buster", priceLast100Learn);
if (!(premiumRank < budgetRank)) {
  failures.push(`Phase C: premium-pick mean rank (${premiumRank.toFixed(2)}) not strictly better than budget-buster, the CVR champion (${budgetRank.toFixed(2)}) — ranking does not follow revenue`);
}

console.log("\n== Phase D: zero-history late entrant under the WEIGHTED objective ==");
const luxury = priceState.get(PRICE_LATE.product_id);
console.log(
  `  newcomer (${PRICE_LATE.product_id}) cvr=0.040 price=$200 rev/imp=8.00  imp=${luxury.impressions} conv=${luxury.conversions}`,
);
console.log(`  newcomer shown first 40 rounds: ${(priceShownRate(PRICE_LATE.product_id, priceFirst40Late) * 100).toFixed(1)}%  (top-3 of 5)`);
console.log(`  newcomer top1  last 100 rounds: ${(priceTop1Rate(PRICE_LATE.product_id, priceLast100Late) * 100).toFixed(1)}%`);

const luxuryShownEarly = priceShownRate(PRICE_LATE.product_id, priceFirst40Late);
if (luxuryShownEarly < 0.9) {
  failures.push(`Phase D: zero-history newcomer shown in first 40 rounds was ${(luxuryShownEarly * 100).toFixed(1)}% (need >= 90%) — weighted objective broke fair exploration`);
}
const luxuryTop1 = priceTop1Rate(PRICE_LATE.product_id, priceLast100Late);
if (luxuryTop1 < 0.8) {
  failures.push(`Phase D: newcomer top-1 in last 100 rounds was ${(luxuryTop1 * 100).toFixed(1)}% (need >= 80%) — must converge to true best REVENUE`);
}

console.log("\n" + "=".repeat(62));
if (failures.length === 0) {
  console.log("RESULT: PASS - converges to true best; late entrant explored then discovered");
  process.exit(0);
} else {
  for (const f of failures) console.log("  FAIL:", f);
  console.log("RESULT: FAIL");
  process.exit(1);
}