-- AlterTable
ALTER TABLE "delivery_settings" ADD COLUMN     "cod_charge" DECIMAL(10,2) NOT NULL DEFAULT 20.00,
ADD COLUMN     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "delivery_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maximum_cod_order_amount" DECIMAL(10,2) NOT NULL DEFAULT 5000.00,
ADD COLUMN     "minimum_cod_order_amount" DECIMAL(10,2) NOT NULL DEFAULT 100.00,
ADD COLUMN     "minimum_order_amount" DECIMAL(10,2) NOT NULL DEFAULT 199.00,
ADD COLUMN     "pickup_cod_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cod_charge" DECIMAL(10,2) NOT NULL DEFAULT 0.00;
