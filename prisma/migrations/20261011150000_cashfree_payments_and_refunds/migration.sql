-- Cashfree integration (D-020, docs/CASHFREE_PLAN.md): provider-neutral payment columns,
-- no stored payment signature, refunds (D-014).

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('CASHFREE');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

-- Old fake rows from the removed Razorpay mock (dev data only)
DELETE FROM "payments" WHERE "razorpay_order_id" LIKE 'order_RpMock_%';

-- Rename instead of drop/add so existing values are kept
DROP INDEX "payments_razorpay_order_id_key";
ALTER TABLE "payments" RENAME COLUMN "razorpay_order_id" TO "gateway_order_id";
ALTER TABLE "payments" RENAME COLUMN "razorpay_payment_id" TO "gateway_payment_id";
ALTER TABLE "payments" DROP COLUMN "razorpay_signature";
ALTER TABLE "payments"
ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "payment_method_detail" VARCHAR(50),
ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'CASHFREE',
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "gateway_refund_id" VARCHAR(100),
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_order_id_key" ON "refunds"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_gateway_order_id_key" ON "payments"("provider", "gateway_order_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
