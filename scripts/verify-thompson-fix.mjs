// #5: Verify thompson-sampling median price weight for unpriced candidates.
//
// BEFORE/AFTER demonstration on a mixed priced/unpriced pool:
//   pool = 2 unpriced + 3 priced ($10, $40, $60), identical CVR (5/10) each.
//   Fixed rng = 0.5 so every Beta draw is identical -> the ONLY variable in the
//   sort key (sample * priceWeight) is the unpriced candidates' weight.
//   unpriced fraction = 2/5 = 0.4 <= REVENUE_WEIGHT_FALLBACK_FRACTION (0.5),
//   so the WEIGHTED path is taken (not the pure-CVR fallback).
//
//   BEFORE (old code): unpriced weight was a flat 1.0 -> scores ~0.5 vs priced
//     scores of 5/20/30 -> unpriced items sank to LAST place purely for being
//     unpriced, even with identical conversion performance.
//   AFTER (shipped): unpriced weight = median($10,$40,$60) = $40 -> scores tie
//     priced_40 (20) and beat priced_10 (5). Unpriced no longer sinks.
//
// The "before" ranking is replicated inline from the old weight rule; the
// "after" ranking is produced by the shipped rankByThompsonSampling().
import { rankByThompsonSampling } from "../app/utils/thompson-sampling.ts";

var candidates = [
  { product_id: "priced_10", price: 10, impressions: 10, conversions: 5 },
  { product_id: "priced_60", price: 60, impressions: 10, conversions: 5 },
  { product_id: "priced_40", price: 40, impressions: 10, conversions: 5 },
  { product_id: "unpriced_A", impressions: 10, conversions: 5 },
  { product_id: "unpriced_B", impressions: 10, conversions: 5 },
];

var rng = function () { return 0.5; };

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- BEFORE
// Old rule: priceWeight = candidate.price if positive, else a flat 1.0.
var before = candidates
  .map(function (c) {
    var w = typeof c.price === "number" && c.price > 0 ? c.price : 1;
    return { id: c.product_id, score: 0.5 * w };
  })
  .sort(function (a, b) { return b.score - a.score; })
  .map(function (s) { return s.id; });

console.log("=== #5 THOMPSON-SAMPLING MEDIAN WEIGHT: BEFORE/AFTER ===");
console.log("Pool: priced_10($10), priced_60($60), priced_40($40), unpriced_A, unpriced_B");
console.log("All have identical CVR (5/10). Fixed rng=0.5 -> all Beta draws equal,");
console.log("so the sort is decided by priceWeight alone. Unpriced fraction 2/5 = 0.4");
console.log("is <= 0.5, so the WEIGHTED path runs (not the pure-CVR fallback).");
console.log("");
console.log("BEFORE (flat 1.0 for unpriced): " + JSON.stringify(before));
if (!before.slice(-2).every(function (id) { return id.startsWith("unpriced"); })) {
  fail("the replicated BEFORE ranking does not show the old bug — this test is invalid");
}
console.log("  -> unpriced_A/unpriced_B at the LAST two places (the old bug, reproduced).");
console.log("");

// ------------------------------------------------------------------ AFTER
var after = rankByThompsonSampling(candidates, { rng: rng });
console.log("AFTER  (shipped median weight):   " + JSON.stringify(after));
console.log("  unpriced weight = median(10,40,60) = 40; score = 0.5*40 = 20.");
console.log("");

if (after.slice(-2).every(function (id) { return id.startsWith("unpriced"); })) {
  fail("unpriced items still sank to the bottom — the flat-1.0 bug is still present");
}
var idx10 = after.indexOf("priced_10");
var idxA = after.indexOf("unpriced_A");
var idxB = after.indexOf("unpriced_B");
if (idx10 < 0) fail("priced_10 missing from the ranking");
if (idxA < 0 || idxB < 0) fail("unpriced candidates missing from the ranking");
if (idxA > idx10 || idxB > idx10) {
  fail("an unpriced candidate ranked BELOW priced_10 — median weight 40 should beat price 10");
}
if (after[0] !== "priced_60") fail("priced_60 (score 30) should rank first, got: " + after[0]);
var fallbackOrder = ["priced_10", "priced_60", "priced_40", "unpriced_A", "unpriced_B"];
if (JSON.stringify(after) === JSON.stringify(fallbackOrder)) {
  fail("ranking equals the pure-CVR fallback order — the weighted path did not run");
}
console.log("priced_10 rank: " + idx10 + ", unpriced_A rank: " + idxA + ", unpriced_B rank: " + idxB + " (0-indexed)");
console.log("");
console.log("PASS: BEFORE the unpriced items sank to last place on a flat 1.0 weight;");
console.log("      AFTER they rank above priced_10 (median 40 > 10) and nowhere near");
console.log("      the bottom. An unpriced item no longer sinks purely for being unpriced.");
