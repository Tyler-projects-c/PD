-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- pgcrypto powers the gen_random_uuid() column defaults below. Neon ships it by
-- default; this line keeps a fresh-DB replay (e.g. local Postgres) self-sufficient.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "public"."compliance_requests" (
    "request_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_domain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "action_taken" TEXT,

    CONSTRAINT "compliance_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "public"."events" (
    "event_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "visitor_id" UUID NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "product_id" TEXT,
    "surface" TEXT,
    "surface_ref" TEXT,
    "variant" TEXT,
    "position_shown" INTEGER,
    "order_id" TEXT,
    "revenue" DECIMAL(12,2),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "public"."experiment_assignments" (
    "visitor_id" UUID NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "surface_ref" TEXT NOT NULL,
    "experiment_id" UUID NOT NULL,
    "variant" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("visitor_id","surface","surface_ref")
);

-- CreateTable
CREATE TABLE "public"."product_surface_stats" (
    "product_id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "surface_ref" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "last_updated" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_surface_stats_pkey" PRIMARY KEY ("product_id","shop_domain","surface","surface_ref")
);

-- CreateTable
CREATE TABLE "public"."products" (
    "product_id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "inventory_available" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_excluded" BOOLEAN NOT NULL DEFAULT false,
    "launch_window_end" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("product_id","shop_domain")
);

-- CreateTable
CREATE TABLE "public"."shopify_sessions" (
    "id" VARCHAR(255) NOT NULL,
    "shop" VARCHAR(255) NOT NULL,
    "state" VARCHAR(255) NOT NULL,
    "isOnline" BOOLEAN NOT NULL,
    "scope" VARCHAR(1024),
    "expires" INTEGER,
    "accessToken" VARCHAR(255),
    "refreshToken" VARCHAR(255),
    "refreshTokenExpires" BIGINT,
    "userId" BIGINT,
    "firstName" VARCHAR(255),
    "lastName" VARCHAR(255),
    "email" VARCHAR(255),
    "accountOwner" BOOLEAN,
    "locale" VARCHAR(255),
    "collaborator" BOOLEAN,
    "emailVerified" BOOLEAN,

    CONSTRAINT "shopify_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shopify_sessions_migrations" (
    "migration_name" VARCHAR(255) NOT NULL,

    CONSTRAINT "shopify_sessions_migrations_pkey" PRIMARY KEY ("migration_name")
);

-- CreateTable
CREATE TABLE "public"."shops" (
    "shop_domain" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "installed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMPTZ(6),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("shop_domain")
);

-- CreateTable
CREATE TABLE "public"."visitors" (
    "visitor_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shop_domain" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("visitor_id")
);

-- CreateIndex
CREATE INDEX "idx_events_shop_type" ON "public"."events"("shop_domain" ASC, "event_type" ASC);

-- CreateIndex
CREATE INDEX "idx_events_surface" ON "public"."events"("shop_domain" ASC, "surface" ASC, "surface_ref" ASC);

-- CreateIndex
CREATE INDEX "idx_events_visitor" ON "public"."events"("visitor_id" ASC);

-- CreateIndex
CREATE INDEX "idx_assignments_experiment" ON "public"."experiment_assignments"("experiment_id" ASC);

-- CreateIndex
CREATE INDEX "idx_assignments_shop_surface" ON "public"."experiment_assignments"("shop_domain" ASC, "surface" ASC, "surface_ref" ASC);

-- CreateIndex
CREATE INDEX "idx_products_shop" ON "public"."products"("shop_domain" ASC);

-- CreateIndex
CREATE INDEX "idx_visitors_shop" ON "public"."visitors"("shop_domain" ASC);

-- AddForeignKey
ALTER TABLE "public"."events" ADD CONSTRAINT "events_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."events" ADD CONSTRAINT "events_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("visitor_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."experiment_assignments" ADD CONSTRAINT "experiment_assignments_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."experiment_assignments" ADD CONSTRAINT "experiment_assignments_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("visitor_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_surface_stats" ADD CONSTRAINT "product_surface_stats_product_id_shop_domain_fkey" FOREIGN KEY ("product_id", "shop_domain") REFERENCES "public"."products"("product_id", "shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."product_surface_stats" ADD CONSTRAINT "product_surface_stats_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."products" ADD CONSTRAINT "products_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."visitors" ADD CONSTRAINT "visitors_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "public"."shops"("shop_domain") ON DELETE CASCADE ON UPDATE NO ACTION;
