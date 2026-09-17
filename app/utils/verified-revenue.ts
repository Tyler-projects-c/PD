/**
 * Revenue trust hardening — shared revenue resolution helper.
 *
 * DECISION POINT (flagged to the product owner, see task "revenue trust
 * hardening"): when reporting/attribution reads a `checkout_completed` event,
 * which revenue should it use?
 *
 *   - `events.revenue`           = browser/pixel-reported (raw, untrusted)
 *   - `events.verified_revenue`  = Shopify `orders/paid` webhook value (authoritative)
 *
 * Chosen default: **prefer verified where available, fall back to the raw
 * browser value while verification is still pending.** Rationale: a checkout
 * that happened minutes ago has no webhook yet; dropping it to 0 would make
 * recent revenue vanish and the attribution window's recent edge drift to zero.
 * Falling back keeps reporting continuous, and the value self-corrects the
 * moment the webhook lands. Rows that never verify are marked `unverified` after
 * 24h and still report their raw value (flagged, not silently trusted).
 *
 * This is intentional and reversible: swap `effectiveRevenue()` to return 0 for
 * non-verified rows if strict-verified-only reporting is wanted later.
 */

export type RevenueBearingRow = {
  revenue?: unknown;
  verified_revenue?: unknown;
};

/** Coerce a Prisma Decimal / number / numeric string to a finite number, else null. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Effective revenue for one event row: verified value when present,
 * otherwise the raw browser-reported value, otherwise 0.
 */
export function effectiveRevenue(row: RevenueBearingRow | null | undefined): number {
  if (!row) return 0;
  const verified = toNumberOrNull(row.verified_revenue);
  if (verified !== null) return verified;
  const raw = toNumberOrNull(row.revenue);
  return raw === null ? 0 : raw;
}

/**
 * Which source `effectiveRevenue()` would use — for debugging/verification
 * output. Deliberately returns "raw", NOT "unverified": this describes where
 * the NUMBER came from and must not be confused with the row's
 * `verification_status`. A row can be `pending` (no webhook yet) or already
 * swept to `unverified`, and in BOTH cases the number still comes from the raw
 * browser value — so a status word here would be ambiguous, while "raw" is not.
 */
export function revenueSource(
  row: RevenueBearingRow | null | undefined,
): "verified" | "raw" | "none" {
  if (!row) return "none";
  if (toNumberOrNull(row.verified_revenue) !== null) return "verified";
  if (toNumberOrNull(row.revenue) !== null) return "raw";
  return "none";
}