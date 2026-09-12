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

console.log("\n" + "=".repeat(62));
if (failures.length === 0) {
  console.log("RESULT: PASS - converges to true best; late entrant explored then discovered");
  process.exit(0);
} else {
  for (const f of failures) console.log("  FAIL:", f);
  console.log("RESULT: FAIL");
  process.exit(1);
}