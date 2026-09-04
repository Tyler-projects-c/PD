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
 * (visitor_id, surface, surface_ref): the upsert's update branch is empty, so
 * an existing row is returned untouched and its variant is never re-rolled.
 * The PK also makes concurrent first-visits safe — the loser of the race hits
 * the unique constraint and re-reads via the update branch (upsert retries).
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

  const existing = await db.experiment_assignments.findUnique({
    where: {
      visitor_id_surface_surface_ref: {
        visitor_id: visitorId,
        surface,
        surface_ref: surfaceRef,
      },
    },
  });

  const row = await db.experiment_assignments.upsert({
    where: {
      visitor_id_surface_surface_ref: {
        visitor_id: visitorId,
        surface,
        surface_ref: surfaceRef,
      },
    },
    // Stickiness: never modify an existing assignment.
    update: {},
    create: {
      visitor_id: visitorId,
      shop_domain: shopDomain,
      surface,
      surface_ref: surfaceRef,
      experiment_id: experiment.experiment_id,
      variant,
    },
  });

  return {
    variant: row.variant as "control" | "treatment",
    experiment_id: row.experiment_id,
    newly_assigned: existing === null,
  };
}
