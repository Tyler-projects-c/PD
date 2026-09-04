/**
 * Experiment assignment infrastructure (measurement only).
 *
 * This module deliberately contains NO ranking/scoring/Thompson logic — it only
 * decides which arm ("control" | "treatment") a visitor belongs to for a given
 * surface, so the split and stickiness can be measured before any variant
 * behaviour is ever rendered. Nothing here changes what a shopper sees.
 *
 * Config is a hardcoded constant for now (no experiment management UI yet).
 * Each experiment gets a stable UUID generated once and committed — assignment
 * rows reference it, so it must never be regenerated for the same experiment.
 */

import db from "../db.server";

export type Surface = "collection" | "search";

export interface ExperimentConfig {
  /** Stable identifier recorded on every assignment row. */
  experiment_id: string;
  /** The storefront surface this experiment measures. */
  surface: Surface;
  /** Inactive experiments stop assigning new visitors (existing rows persist). */
  active: boolean;
  /** Human-readable note for future maintainers. */
  description: string;
}

export const EXPERIMENTS: Record<string, ExperimentConfig> = {
  collection_ranking_v1: {
    experiment_id: "cd7ffc38-12bf-4d6e-83cb-dde38be1ae6a",
    surface: "collection",
    active: true,
    description: "Future collection-page product ranking split (Phase: measurement only).",
  },
  search_ranking_v1: {
    experiment_id: "65806b14-1e84-44c0-b7db-5917ba22884f",
    surface: "search",
    active: true,
    description: "Future search-results ranking split (Phase: measurement only).",
  },
};

export function activeExperimentForSurface(surface: string): ExperimentConfig | null {
  const experiment = Object.values(EXPERIMENTS).find((e) => e.surface === surface);
  return experiment && experiment.active ? experiment : null;
}

export interface AssignmentResult {
  variant: "control" | "treatment";
  experiment_id: string;
  /** True when this call created the row (first visit), false when sticky. */
  newly_assigned: boolean;
}

/**
 * Assign a visitor to the active experiment for a surface, or return their
 * existing assignment (stickiness).
 *
 * Stickiness is enforced by the table's composite primary key
 * (visitor_id, surface, surface_ref): we INSERT with `skipDuplicates: true`, so
 * an already-existing row is left untouched and its variant is never re-rolled.
 * The PK also makes concurrent first-visits safe — exactly one call inserts,
 * the rest skip and read the winner's committed row (see below).
 *
 * `newly_assigned` is derived FROM the atomic insert itself, not from a
 * separate findUnique beforehand. We INSERT with `skipDuplicates: true` (a
 * single Postgres `INSERT ... ON CONFLICT DO NOTHING`): it returns the count of
 * rows actually created, so a count of 1 means THIS call performed the insert.
 * Under concurrency exactly one call gets count 1 — the rest get 0 and fall
 * through to read the winner's committed, sticky assignment. This is race-free
 * and, unlike a read-then-write upsert, cannot throw a duplicate-key error.
 *
 * Note the surface_ref scoping: a visitor gets an INDEPENDENT random draw per
 * surface_ref (each collection/search is its own experiment instance), while
 * repeat visits to the SAME surface_ref always return the same variant.
 *
 * Returns null when the surface has no active experiment or surface_ref is
 * missing — callers should treat that as "no experiment here" and continue.
 */
export async function assignVisitorToExperiment(
  visitorId: string,
  shopDomain: string,
  surface: Surface,
  surfaceRef: string,
): Promise<AssignmentResult | null> {
  const experiment = activeExperimentForSurface(surface);
  if (!experiment || !surfaceRef) {
    return null;
  }

  const variant: "control" | "treatment" = Math.random() < 0.5 ? "control" : "treatment";

  // INSERT ... ON CONFLICT DO NOTHING (atomic): `count` is 1 iff THIS call
  // created the row. If the row already exists — a repeat visit, or a
  // concurrent first-visit that won — the insert is a no-op and count is 0.
  const { count } = await db.experiment_assignments.createMany({
    data: [
      {
        visitor_id: visitorId,
        shop_domain: shopDomain,
        surface,
        surface_ref: surfaceRef,
        experiment_id: experiment.experiment_id,
        variant,
      },
    ],
    skipDuplicates: true,
  });

  if (count === 1) {
    return {
      variant,
      experiment_id: experiment.experiment_id,
      newly_assigned: true,
    };
  }

  // We lost the race (or this is a repeat visit): the row already exists with a
  // committed, sticky variant — return that, never re-rolling. (`count === 0`
  // above only happens because the ON CONFLICT DO NOTHING absorbed an insert
  // attempt on this exact PK, so the row is guaranteed to exist.)
  const row = await db.experiment_assignments.findUnique({
    where: {
      visitor_id_surface_surface_ref: {
        visitor_id: visitorId,
        surface,
        surface_ref: surfaceRef,
      },
    },
  });
  if (!row) {
    throw new Error(
      `experiment assignment vanished: ${visitorId}/${surface}/${surfaceRef}`,
    );
  }

  return {
    variant: row.variant as "control" | "treatment",
    experiment_id: row.experiment_id,
    newly_assigned: false,
  };
}
