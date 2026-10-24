-- CreateEnum
CREATE TYPE "InventoryTransactionType" AS ENUM ('STOCK_ADDED', 'STOCK_REMOVED', 'STOCK_ADJUSTED', 'ORDER_DEDUCTION', 'ORDER_CANCELLATION_RESTORE');

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "previous_quantity" DECIMAL(10,3) NOT NULL,
    "change_quantity" DECIMAL(10,3) NOT NULL,
    "new_quantity" DECIMAL(10,3) NOT NULL,
    "type" "InventoryTransactionType" NOT NULL,
    "reason" TEXT,
    "performed_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_performed_by_admin_id_fkey" FOREIGN KEY ("performed_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
