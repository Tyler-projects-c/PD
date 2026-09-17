-- ============================================================================
-- add_order_verification_fields
--
-- WHY
-- ----
-- Revenue trust hardening: browser-reported checkout_completed revenue is
-- client-computed and untrusted. Shopify's own orders/paid webhook is the
-- authoritative source. These columns hold the cross-reference WITHOUT ever
-- overwriting the raw browser value (both stay visible for debugging):
--   - verified_revenue: per-line amount from the orders/paid webhook.
--   - verification_status: pending (default, no webhook yet) / verified /
--     mismatch (webhook disagrees beyond the rounding threshold) / unverified
--     (no webhook within the 24h grace window).
--   - verified_at: when the webhook match was written.
-- The orders/paid webhook subscription is registered in shopify.app.toml; see
-- app/routes/webhooks.orders.paid.tsx and app/utils/order-verification.server.ts.
-- CANONICAL VALUES (Prisma cannot model CHECK constraints — keep in sync here):
--   events.verification_status: 'pending' | 'verified' | 'mismatch' | 'unverified'
-- ============================================================================

ALTER TABLE "public"."events" ADD COLUMN IF NOT EXISTS "verified_revenue" DECIMAL(12,2);
ALTER TABLE "public"."events" ADD COLUMN IF NOT EXISTS "verification_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "public"."events" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(6);

-- Existing checkout rows (inserted before this migration) get pending/nulls.
UPDATE "public"."events"
SET "verification_status" = 'pending'
WHERE "verification_status" IS NULL OR "verification_status" = '';

-- Backfill guard: default covers future inserts; keep the constraint strict.
ALTER TABLE "public"."events" DROP CONSTRAINT IF EXISTS "events_verification_status_check";
ALTER TABLE "public"."events" ADD CONSTRAINT "events_verification_status_check" CHECK (
  verification_status = ANY (ARRAY['pending'::text, 'verified'::text, 'mismatch'::text, 'unverified'::text])
);

-- Lookup path for the webhook matcher: (shop, order_id) on checkouts.
CREATE INDEX IF NOT EXISTS "idx_events_order_verification"
  ON "public"."events" ("shop_domain" ASC, "order_id" ASC)
  WHERE "event_type" = 'checkout_completed';
