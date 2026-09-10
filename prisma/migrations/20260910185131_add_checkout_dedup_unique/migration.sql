-- ============================================================================
-- add_checkout_dedup_unique
--
-- WHY
-- ----
-- The /api/events route inserts one `events` row per checkout line item
-- (createMany). A retried POST (network retry, Shopify webhook redelivery, or a
-- double-fire client bug) currently inserts the SAME checkout twice, which
-- double-counts revenue in the attribution query (app/utils/attribution.server.ts).
-- The natural idempotency grain is (shop_domain, order_id, product_id): one
-- checkout = N line-item rows, each distinct by product within the order.
--
-- This is a PARTIAL unique index so that:
--   * only real checkout rows are constrained — non-checkout event types have
--     NULL order_id/product_id and must not collide with each other or with
--     checkouts;
--   * a checkout row with a NULL order_id (theoretically possible for some
--     non-standard orders) is not constrained either, so the constraint is
--     permissive rather than riskily strict.
--
-- Behavior: a second insert with the same (shop_domain, order_id, product_id)
-- and event_type='checkout_completed' is rejected by Postgres with a unique
-- violation (Prisma P2002), which persistEvent() catches and turns into a
-- logged warning instead of a duplicate row.
-- ============================================================================

CREATE UNIQUE INDEX idx_events_checkout_dedup
  ON "events" ("shop_domain", "order_id", "product_id")
  WHERE "event_type" = 'checkout_completed' AND "order_id" IS NOT NULL;