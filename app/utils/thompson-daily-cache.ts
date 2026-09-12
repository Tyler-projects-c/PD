/**
 * Daily-resample cache layer for Thompson Sampling rankings.
 *
 * Contract (design spec, locked): the sampled ranking for a given
 * (visitor_id, surface, surface_ref) is drawn ONCE per UTC calendar day and
 * cached/reused for that whole day — never resampled on every request. This
 * mirrors the sticky-assignment grain in app/utils/experiments.server.ts
 * (the composite key (visitor_id, surface, surface_ref) on experiment_assignments)
 * and adds a date_utc axis to it.
 *
 * This is a SEPARATE cache layer alongside the existing experiment-assignment
 * table — it does NOT reuse or modify that table (which remains the untouched
 * control/treatment split). Storage is injected (a Map satisfies the store
 * interface) so this function is pure and unit-testable without a database; the
 * live wiring (a follow-up task) can back the same interface with durable
 * storage. No imports, no I/O.
 */

export interface DailyRankingEntry {
  /** UTC calendar day the entry was drawn for, "YYYY-MM-DD". */
  dateUtc: string;
  /** Ranked product_ids (draw result) to reuse for the whole day. */
  ranking: string[];
}

/** Minimal storage contract; `new Map()` suffices for tests / in-memory use. */
export interface DailyRankingStore {
  get(key: string): DailyRankingEntry | undefined;
  set(key: string, entry: DailyRankingEntry): void;
}

export interface DailyRankingResult {
  ranking: string[];
  /** True when THIS call produced the fresh draw (first call of the day). */
  drew: boolean;
}

/** UTC calendar day ("YYYY-MM-DD") of a date, in UTC regardless of local tz. */
export function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Cache key: the (visitor_id, surface, surface_ref) grain from the sticky
 * assignment table, prefixed and suffixed with the UTC date so each calendar
 * day gets its own slot.
 */
export function buildDailyCacheKey(
  visitorId: string,
  surface: string,
  surfaceRef: string,
  dateUtc: string,
): string {
  return `thompson_daily:${dateUtc}:${visitorId}:${surface}:${surfaceRef}`;
}

/**
 * Return the day's cached ranking for this visitor/surface/ref, drawing a fresh
 * one (exactly once) when none exists yet for `dateUtc`.
 *
 * A draw whose result is an EMPTY ranking is NOT cached: an empty list usually
 * means "no candidates yet", and caching it would freeze the day before real
 * products arrive. Such a call reports drew=true (it did attempt a draw) so
 * callers can distinguish "cached" from "just drew" truthfully.
 */
export function getOrDrawDailyRanking(
  store: DailyRankingStore,
  visitorId: string,
  surface: string,
  surfaceRef: string,
  dateUtc: string,
  draw: () => string[],
): DailyRankingResult {
  const key = buildDailyCacheKey(visitorId, surface, surfaceRef, dateUtc);
  const cached = store.get(key);
  if (cached && cached.dateUtc === dateUtc && cached.ranking.length > 0) {
    return { ranking: cached.ranking, drew: false };
  }
  const ranking = draw();
  if (ranking.length > 0) {
    store.set(key, { dateUtc, ranking });
  }
  return { ranking, drew: true };
}