/**
 * In-process alert throttle for HIGH-VOLUME rejection paths.
 *
 * WHY THIS EXISTS: the app-proxy HMAC gate rejects every request whose Shopify
 * signature is missing/forged/stale. During a misconfiguration (or the 90s
 * clock-skew window sliding) that path can fire thousands of times an hour.
 * Firing a Sentry event per rejection would bury every other alert under noise
 * and burn the free-tier event quota — which would make the dashboard USELESS
 * exactly when a human needs it.
 *
 * POLICY — first occurrence always alerts; repeats inside the window are
 * suppressed and counted; the first occurrence after the window alerts again
 * and reports how many were suppressed. So nothing is ever hidden for long,
 * and a burst still produces exactly one alert (Sentry groups it as one issue),
 * not zero.
 *
 * ALERTING ONLY: this never retries, blocks, repairs, or changes a response —
 * it only decides whether a log call ALSO fans out to Sentry.
 *
 * SCOPE: per process, in-memory, best-effort. Serverless/multi-instance
 * deployments may hold slightly more than one window open concurrently; that is
 * acceptable for noise control (worst case a few alerts instead of one) and
 * deliberately avoids adding a shared cache dependency for alert plumbing.
 */

interface ThrottleEntry {
  windowStart: number;
  suppressed: number;
}

const entries = new Map<string, ThrottleEntry>();

export interface ThrottleDecision {
  /** True when this call should fan out to Sentry. */
  alert: boolean;
  /** How many occurrences were suppressed since the previous alert. */
  suppressed: number;
}

/**
 * @param key      Stable identity for the alert (e.g. "api.proxy.hmac").
 * @param windowMs Suppression window. The FIRST occurrence always alerts.
 * @param now      Injectable clock, for deterministic tests.
 */
export function shouldAlertToSentry(
  key: string,
  windowMs: number,
  now: number = Date.now(),
): ThrottleDecision {
  const entry = entries.get(key);
  if (!entry) {
    entries.set(key, { windowStart: now, suppressed: 0 });
    return { alert: true, suppressed: 0 };
  }
  if (now - entry.windowStart >= windowMs) {
    const suppressed = entry.suppressed;
    entries.set(key, { windowStart: now, suppressed: 0 });
    return { alert: true, suppressed };
  }
  entry.suppressed += 1;
  return { alert: false, suppressed: entry.suppressed };
}

/** Test-only: clear all throttle state so each harness case starts fresh. */
export function __resetAlertThrottleForTests(): void {
  entries.clear();
}