-- ============================================================================
-- 1_check_constraints
--
-- WHY THIS EXISTS
-- ---------------
-- Prisma's schema model cannot represent CHECK constraints (only column types,
-- nullability, defaults, PKs, FKs, indexes). The live database, however, was
-- built with raw SQL (outside Prisma Migrate) and carries several CHECK
-- constraints that `prisma migrate diff` does NOT emit and schema.prisma does
-- NOT describe. A plain baseline (`migrate diff --from-empty --to-url`) would
-- silently omit them, and a fresh database replayed from migrations would LOSE
-- them.
--
-- This migration is the fidelity capture for those database-side objects:
--   - the `pgcrypto` extension (required by gen_random_uuid() defaults),
--   - every CHECK constraint currently present on the PD tables.
--
-- CANONICAL EXPECTED VALUES (keep in sync with app code):
--   compliance_requests.topic:
--       'customers/data_request', 'customers/redact', 'shop/redact'
--       (matches constants in app/routes/webhooks.customers.*.tsx)
--   events.event_type:
--       'page_viewed', 'search_submitted', 'collection_viewed',
--       'product_viewed', 'product_added_to_cart', 'checkout_completed',
--       'product_impression'
--       (matches EVENT_TYPES in app/routes/api.events.tsx)
--   events.surface:            'search' | 'collection' | NULL
--   events.variant:            'control' | 'treatment' | NULL
--   experiment_assignments.surface: 'search' | 'collection'
--   experiment_assignments.variant: 'control' | 'treatment'
--   product_surface_stats.surface:  'search' | 'collection'
--
-- NOTICE: because Prisma cannot see these constraints, `prisma migrate dev`
-- will never generate a migration for them, and `prisma migrate diff` treats
-- them as non-existent drift-wise. If these sets ever change, edit this file
-- (or add a new migration) BY HAND and verify with `prisma migrate deploy`.
-- ============================================================================

-- pgcrypto is a Neon default and provides gen_random_uuid()/digest() used by the
-- UUID column defaults in 0_init. Idempotent so replay on any host is safe.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- compliance_requests.topic
ALTER TABLE "compliance_requests" DROP CONSTRAINT IF EXISTS "compliance_requests_topic_check";
ALTER TABLE "compliance_requests" ADD CONSTRAINT "compliance_requests_topic_check" CHECK (
  topic = ANY (ARRAY['customers/data_request'::text, 'customers/redact'::text, 'shop/redact'::text])
);

-- events.event_type (BEFORE 2026-09-09 this constraint omitted 'product_impression',
-- which silently dropped every impression INSERT at the DB layer while the app code
-- and Prisma schema both allowed it. The value set below is the corrected, current
-- state and matches EVENT_TYPES in app/routes/api.events.tsx.)
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_event_type_check";
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_check" CHECK (
  event_type = ANY (ARRAY[
    'page_viewed'::text,
    'search_submitted'::text,
    'collection_viewed'::text,
    'product_viewed'::text,
    'product_added_to_cart'::text,
    'checkout_completed'::text,
    'product_impression'::text
  ])
);

-- events.surface / events.variant
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_surface_check";
ALTER TABLE "events" ADD CONSTRAINT "events_surface_check" CHECK (
  surface = ANY (ARRAY['search'::text, 'collection'::text, NULL::text])
);
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_variant_check";
ALTER TABLE "events" ADD CONSTRAINT "events_variant_check" CHECK (
  variant = ANY (ARRAY['control'::text, 'treatment'::text, NULL::text])
);

-- experiment_assignments.surface / experiment_assignments.variant
ALTER TABLE "experiment_assignments" DROP CONSTRAINT IF EXISTS "experiment_assignments_surface_check";
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_surface_check" CHECK (
  surface = ANY (ARRAY['search'::text, 'collection'::text])
);
ALTER TABLE "experiment_assignments" DROP CONSTRAINT IF EXISTS "experiment_assignments_variant_check";
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_variant_check" CHECK (
  variant = ANY (ARRAY['control'::text, 'treatment'::text])
);

-- product_surface_stats.surface
ALTER TABLE "product_surface_stats" DROP CONSTRAINT IF EXISTS "product_surface_stats_surface_check";
ALTER TABLE "product_surface_stats" ADD CONSTRAINT "product_surface_stats_surface_check" CHECK (
  surface = ANY (ARRAY['search'::text, 'collection'::text])
);