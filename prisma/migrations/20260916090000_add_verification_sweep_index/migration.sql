-- ===========================================================================
-- add_verification_sweep_index
--
-- WHY
-- ----
-- sweepStaleVerifications() (app/utils/order-verification.server.ts) marks
-- still-pending checkout rows older than the 24h grace window as 'unverified'.
-- It is piggybacked on the orders/paid webhook (this app has no cron service),
-- so its query must stay cheap as the events table grows:
--     WHERE shop_domain = $1
--       AND event_type = 'checkout_completed'
--       AND verification_status = 'pending'
--       AND occurred_at < now() - 24h
--
-- Mirrors @@index([shop_domain, verification_status, occurred_at]) in
-- prisma/schema.prisma.
--
-- Kept as a SEPARATE migration rather than folded into
-- 20260915120000_add_order_verification_fields because that migration is
-- already applied to the database and Prisma checksums applied migrations --
-- editing an applied migration invalidates it.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS "idx_events_verification_sweep"
  ON "public"."events" ("shop_domain" ASC, "verification_status" ASC, "occurred_at" ASC);