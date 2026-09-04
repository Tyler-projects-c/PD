/**
 * Attribution query — the measurement layer that answers "did treatment
 * outperform control?" for a single experiment instance.
 *
 * Attribution can only be answered PER experiment instance: the
 * (shop_domain, surface, surface_ref) triple identifies exactly one instance
 * (e.g. collection "col-abc"). A purchase is attributed to an arm iff the
 * visitor has an assignment row for THAT EXACT instance in that arm.
 *
 * Why the join works:
 *   - checkout_completed events carry NO surface/surface_ref (the pixel sends
 *     only order_id/revenue/line_items for purchases), so a checkout can never
 *     be linked to a surface without going through the visitor's assignment.
 *   - A visitor has at most ONE assignment per (visitor_id, surface, surface_ref)
 *     (the table's composite primary key), so every checkout event resolves to
 *     exactly one arm for the measured instance — there is no double-counting
 *     within an instance, and a purchase is never attributed to a different
 *     instance's experiment than the one that actually influenced the visitor.
 *
 * Temporal constraint: a checkout is attributed to an arm only if it occurred
 * AT OR AFTER that visitor's `assigned_at` for this exact instance. A purchase
 * made BEFORE the visitor was ever assigned to this collection/search is not a
 * conversion this experiment could have influenced — counting it would be
 * backwards causality that inflates lift for repeat customers. So `occurred_at`
 * on the event is compared against `assigned_at` on the assignment row; only
 * checkouts at-or-after the assignment timestamp count toward either arm.
 *
 * This module is deliberately the only place these numbers are derived, so a
 * future dashboard and the verification harness exercise the same logic.
 */

import db from "../db.server";

export interface AttributionGroup {
  /** Distinct visitors with an assignment to this instance in this arm. */
  assigned_visitors: number;
  /** Distinct visitors in the arm who completed >=1 checkout for this instance. */
  purchasing_visitors: number;
  /** purchasing_visitors / assigned_visitors (0..1); null when nobody assigned. */
  conversion_rate: number | null;
  /** Sum of revenue over that arm's matched checkout events (2dp). */
  total_revenue: number;
}

export interface AttributionResult {
  shop_domain: string;
  surface: string;
  surface_ref: string;
  experiment_id: string | null;
  computed_at: string;
  control: AttributionGroup;
  treatment: AttributionGroup;
  lift: {
    /** ((treat - control) / control) * 100; null when control = 0 (div by zero). */
    conversion_rate_pct: number | null;
    /** ((treat - control) / control) * 100; null when control revenue = 0. */
    revenue_pct: number | null;
  };
}

const ARMS = ["control", "treatment"] as const;
type Arm = (typeof ARMS)[number];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function pctLift(treatment: number, control: number): number | null {
  if (!Number.isFinite(control) || control === 0) return null;
  return Math.round(((treatment - control) / control) * 10000) / 100;
}

export async function computeAttribution(opts: {
  shop_domain: string;
  surface: string;
  surface_ref: string;
}): Promise<AttributionResult> {
  const { shop_domain, surface, surface_ref } = opts;

  // 1. Every assignment for this instance → which arm each visitor is in, plus
  //    that visitor's assigned_at so we can enforce the temporal constraint.
  const assignments = await db.experiment_assignments.findMany({
    where: { shop_domain, surface, surface_ref },
    select: { visitor_id: true, variant: true, experiment_id: true, assigned_at: true },
  });

  const visitorsByArm: Record<Arm, Set<string>> = { control: new Set(), treatment: new Set() };
  const armOfVisitor: Record<string, Arm> = {};
  const assignedAtOfVisitor: Record<string, Date> = {};
  let experimentId: string | null = null;

  for (const a of assignments) {
    experimentId = a.experiment_id;
    if (a.variant !== "control" && a.variant !== "treatment") continue;
    visitorsByArm[a.variant].add(a.visitor_id);
    // One assignment per (visitor, surface, surface_ref), so this is exact.
    armOfVisitor[a.visitor_id] = a.variant;
    assignedAtOfVisitor[a.visitor_id] = a.assigned_at;
  }

  const allVisitorIds = [...new Set(assignments.map((a) => a.visitor_id))];

  // 2. All purchase events from those visitors. Anchored purely by the visitor:
  //    the instance scoping already happened in step 1. occurred_at is pulled
  //    too so step 3 can enforce the at-or-after-assignment constraint.
  const checkouts = allVisitorIds.length
    ? await db.events.findMany({
        where: {
          shop_domain,
          event_type: "checkout_completed",
          visitor_id: { in: allVisitorIds },
        },
        select: { visitor_id: true, revenue: true, occurred_at: true },
      })
    : [];

  // 3. Attribute each checkout to an arm via its visitor's assignment. Only a
  //    checkout that happened AT OR AFTER the visitor's assigned_at counts —
  //    a purchase made before they were ever assigned to this instance was not
  //    influenced by it and must not be counted for either arm.
  const purchasing: Record<Arm, Set<string>> = { control: new Set(), treatment: new Set() };
  const revenue: Record<Arm, number> = { control: 0, treatment: 0 };

  for (const ev of checkouts) {
    const arm = armOfVisitor[ev.visitor_id];
    if (!arm) continue; // checkout from a visitor not assigned to this instance
    if (ev.occurred_at.getTime() < assignedAtOfVisitor[ev.visitor_id].getTime()) {
      continue; // purchase predates the assignment — not attributable to it
    }
    purchasing[arm].add(ev.visitor_id);
    const amount = Number(ev.revenue);
    if (Number.isFinite(amount)) revenue[arm] += amount;
  }

  const group = (arm: Arm): AttributionGroup => {
    const assigned = visitorsByArm[arm].size;
    const buyers = purchasing[arm].size;
    return {
      assigned_visitors: assigned,
      purchasing_visitors: buyers,
      conversion_rate: assigned > 0 ? buyers / assigned : null,
      total_revenue: round2(revenue[arm]),
    };
  };

  const control = group("control");
  const treatment = group("treatment");

  return {
    shop_domain,
    surface,
    surface_ref,
    experiment_id: experimentId,
    computed_at: new Date().toISOString(),
    control,
    treatment,
    lift: {
      conversion_rate_pct: pctLift(treatment.conversion_rate ?? 0, control.conversion_rate ?? 0),
      revenue_pct: pctLift(treatment.total_revenue, control.total_revenue),
    },
  };
}
