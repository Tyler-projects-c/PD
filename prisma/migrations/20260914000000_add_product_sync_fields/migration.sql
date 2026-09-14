-- Product/inventory sync (webhooks + daily reconciliation pull).
-- See app/utils/product-sync.server.ts.
ALTER TABLE "products" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "products" ADD COLUMN "inventory_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "shops" ADD COLUMN "products_reconciled_at" TIMESTAMPTZ(6);
