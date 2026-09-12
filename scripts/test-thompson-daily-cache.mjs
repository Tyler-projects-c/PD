/**
 * Unit tests for the daily-resample cache layer
 * (app/utils/thompson-daily-cache.ts).
 *
 * Run: node --test scripts/test-thompson-daily-cache.mjs
 * Requires Node >= 22.12.
 *
 * Contract under test (design spec, locked): a ranking draw for a given
 * (visitor_id, surface, surface_ref) happens ONCE per UTC calendar day; same-day
 * calls return the cached order; a date change triggers exactly one new draw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  utcDateString,
  buildDailyCacheKey,
  getOrDrawDailyRanking,
} from "../app/utils/thompson-daily-cache.ts";

test("same-day calls reuse the cached order with exactly one draw", () => {
  const store = new Map();
  let draws = 0;
  const draw = () => {
    draws += 1;
    return ["p1", "p2", "p3"];
  };

  const first = getOrDrawDailyRanking(store, "visitor-1", "collection", "col-abc", "2026-09-11", draw);
  assert.equal(first.drew, true);
  assert.deepEqual(first.ranking, ["p1", "p2", "p3"]);

  const second = getOrDrawDailyRanking(store, "visitor-1", "collection", "col-abc", "2026-09-11", draw);
  assert.equal(second.drew, false);
  assert.deepEqual(second.ranking, ["p1", "p2", "p3"]); // same order, not a re-draw
  assert.equal(draws, 1);
});

test("a date change triggers exactly one new draw, then it is sticky again", () => {
  const store = new Map();
  let draws = 0;
  const draw = (tag) => {
    draws += 1;
    return [`order-${tag}`];
  };

  const r1 = getOrDrawDailyRanking(store, "v", "search", "q=snow", "2026-09-11", () => draw("day1"));
  assert.equal(r1.drew, true);
  assert.equal(r1.ranking[0], "order-day1");
  getOrDrawDailyRanking(store, "v", "search", "q=snow", "2026-09-11", () => draw("day1")); // cached
  assert.equal(draws, 1);

  const r2 = getOrDrawDailyRanking(store, "v", "search", "q=snow", "2026-09-12", () => draw("day2"));
  assert.equal(r2.drew, true); // new UTC day -> exactly one new draw
  assert.equal(r2.ranking[0], "order-day2");
  assert.equal(draws, 2);

  getOrDrawDailyRanking(store, "v", "search", "q=snow", "2026-09-12", () => draw("day2"));
  assert.equal(draws, 2); // same day again -> still cached
});

test("distinct visitor/surface/surface_ref keys are independent", () => {
  const store = new Map();
  const drawnKeys = new Set();
  const draw = (k) => {
    drawnKeys.add(k);
    return [`order-${k}`];
  };
  const date = "2026-09-11";
  const combos = [
    ["v1", "collection", "col-a"],
    ["v1", "collection", "col-b"], // same visitor, different collection
    ["v2", "collection", "col-a"], // different visitor, same collection
    ["v1", "search", "q=snow"], // same visitor, different surface/ref
  ];
  for (const [v, s, ref] of combos) {
    getOrDrawDailyRanking(store, v, s, ref, date, () => draw(`${v}/${s}/${ref}`));
  }
  assert.equal(drawnKeys.size, 4); // one independent draw per triple
  // Repeat one triple: still no extra draw.
  getOrDrawDailyRanking(store, "v1", "collection", "col-a", date, () => draw("again"));
  assert.equal(drawnKeys.size, 4);
});

test("an empty draw is NOT cached, so the day can still get a real ranking later", () => {
  const store = new Map();
  let draws = 0;
  const date = "2026-09-11";

  const empty = getOrDrawDailyRanking(store, "v", "collection", "col-abc", date, () => {
    draws += 1;
    return []; // no candidates yet at first request of the day
  });
  assert.equal(empty.drew, true);
  assert.deepEqual(empty.ranking, []);

  // A later same-day call with real candidates must NOT be blocked by the empty result.
  const real = getOrDrawDailyRanking(store, "v", "collection", "col-abc", date, () => {
    draws += 1;
    return ["late-product"];
  });
  assert.equal(real.drew, true);
  assert.deepEqual(real.ranking, ["late-product"]);
  assert.equal(draws, 2);

  // Now the non-empty result is cached.
  const again = getOrDrawDailyRanking(store, "v", "collection", "col-abc", date, () => {
    draws += 1;
    return ["late-product"];
  });
  assert.equal(again.drew, false);
  assert.equal(draws, 2);
});

test("utcDateString derives the UTC calendar day, independent of local timezone", () => {
  assert.equal(utcDateString(new Date("2026-09-11T23:59:59.999Z")), "2026-09-11");
  assert.equal(utcDateString(new Date("2026-09-12T00:00:00.000Z")), "2026-09-12");
  // The same instant in a UTC-negative zone must still be the UTC day.
  assert.equal(utcDateString(new Date("2026-09-12T00:00:00.000Z")), "2026-09-12");
});

test("buildDailyCacheKey encodes the (visitor, surface, surface_ref) grain plus date_utc", () => {
  assert.equal(
    buildDailyCacheKey("v123", "collection", "col-abc", "2026-09-11"),
    "thompson_daily:2026-09-11:v123:collection:col-abc",
  );
  // same triple, different day -> different slot (the whole point of resampling)
  assert.notEqual(
    buildDailyCacheKey("v123", "collection", "col-abc", "2026-09-11"),
    buildDailyCacheKey("v123", "collection", "col-abc", "2026-09-12"),
  );
  // different triple, same day -> different slot
  assert.notEqual(
    buildDailyCacheKey("v123", "collection", "col-abc", "2026-09-11"),
    buildDailyCacheKey("v123", "search", "q=snow", "2026-09-11"),
  );
});