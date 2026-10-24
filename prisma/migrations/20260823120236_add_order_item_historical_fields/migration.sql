-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "product_name" VARCHAR(100) NOT NULL DEFAULT 'Unknown',
ADD COLUMN     "unit" "ProductUnit" NOT NULL DEFAULT 'KG';
