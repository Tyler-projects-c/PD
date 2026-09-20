-- Webhook-first verification ledger: orders/paid amounts parked here when the
-- webhook arrives BEFORE the browser's checkout_completed row exists (the
-- common race - webhook delivery beats the thank-you-page pixel). Keyed by
-- (shop_domain, order_id, product_id); persistEvent in app/routes/api.events.tsx
-- consumes rows on checkout insert and marks the new row verified immediately.
-- Rows whose browser row arrives later are consumed and deleted by the same
-- path, so the ledger only holds genuinely unmatched lines.
CREATE TABLE IF NOT EXISTS "public"."webhook_revenue_ledger" (
  "shop_domain" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  -- Per-line authoritative amount, post-discount (webhook price x quantity
  -- minus discount_allocations - see app/utils/order-verification.server.ts).
  "amount" DECIMAL(12,2) NOT NULL,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_revenue_ledger_pkey" PRIMARY KEY ("shop_domain", "order_id", "product_id")
);

CREATE INDEX IF NOT EXISTS "idx_ledger_order"
  ON "public"."webhook_revenue_ledger" ("shop_domain" ASC, "order_id" ASC);

-- Distinguish "genuinely out of stock" from "untracked / always available"
-- in the candidate filter (see app/utils/thompson-ranking.server.ts and the
-- INVENTORY ROLLUP note on normalizeProduct in product-sync.server.ts).
ALTER TABLE "public"."products" ADD COLUMN IF NOT EXISTS "always_available" BOOLEAN NOT NULL DEFAULT false;