-- ============================================================================
-- add_stats_surface_index_and_ranking_cache
--
-- WHY
-- ----
-- 1) product_surface_stats index for instance lookups.
--    The table's primary key is (product_id, shop_domain, surface, surface_ref);
--    its LEADING column is product_id, so a query that filters by the instance
--    (shop_domain, surface, surface_ref) alone — the daily rollup and the
--    Thompson ranking candidate read — cannot use the PK and would scan the
--    whole table. This adds the same (shop_domain, surface, surface_ref) index
--    the events and experiment_assignments tables already have
--    (idx_events_surface / idx_assignments_shop_surface), named consistently.
--
-- 2) thompson_daily_rankings table.
--    The Thompson daily-resample cache (app/utils/thompson-daily-cache.ts) is an
--    injected sync store keyed by buildDailyCacheKey: "thompson_daily:{dateUtc}:
--    {visitorId}:{surface}:{surfaceRef}". The live wiring must back it with
--    durable storage, and this table is that backing: one row per
--    (visitor_id, shop_domain, surface, surface_ref, date_utc) storing the day's
--    draw result. On GDPR shop/redact it is removed via its FKs to shops and
--    visitors (ON DELETE CASCADE), and the redact webhook's explicit wipe is
--    updated in app/routes/webhooks.shop.redact.tsx.
-- ============================================================================

-- 1) product_surface_stats.surface instance index
CREATE INDEX "idx_stats_shop_surface" ON "public"."product_surface_stats" ("shop_domain" ASC, "surface" ASC, "surface_ref" ASC);

-- 2) Durable Thompson daily-resample ranking cache
CREATE TABLE "public"."thompson_daily_rankings" (
    "visitor_id" UUID NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "surface_ref" TEXT NOT NULL,
    "date_utc" VARCHAR(10) NOT NULL,
    "ranking" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "thompson_daily_rankings_pkey" PRIMARY KEY ("visitor_id","shop_domain","surface","surface_ref","date_utc")
);

-- Surface CHECK constraint (Prisma cannot represent these; kept in sync with
-- prisma/README.md canonical values and app/utils/experiments.server.ts).
ALTER TABLE "public"."thompson_daily_rankings" DROP CONSTRAINT IF EXISTS "thompson_daily_rankings_surface_check";
ALTER TABLE "public"."thompson_daily_rankings" ADD CONSTRAINT "thompson_daily_rankings_surface_check" CHECK (
  surface = ANY (ARRAY['search'::text, 'collection'::text])
);

-- Fast lookup by (shop_domain, surface, surface_ref): where rankings live and
-- cleanup/audit scans; matches idx_stats_shop_surface naming convention.
CREATE INDEX "idx_daily_rankings_surface" ON "public"."thompson_daily_rankings" ("shop_domain" ASC, "surface" ASC, "surface_ref" ASC);

-- FKs (GDPR shop/redact cascades via both relations).
ALTER TABLE "public"."thompson_daily_rankings" ADD CONSTRAINT "thompson_daily_rankings_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "public"."thompson_daily_rankings" ADD CONSTRAINT "thompson_daily_rankings_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("visitor_id") ON DELETE CASCADE ON UPDATE NO ACTION;