-- Remove unsupported payment state from UNIQUE BASKET payment lifecycle.
CREATE TYPE "PaymentStatus_new" AS ENUM ('PENDING', 'PAID', 'FAILED');

ALTER TABLE "orders" ALTER COLUMN "payment_status" DROP DEFAULT;
ALTER TABLE "orders"
  ALTER COLUMN "payment_status" TYPE "PaymentStatus_new"
  USING ("payment_status"::text::"PaymentStatus_new");

ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";
ALTER TYPE "PaymentStatus_new" RENAME TO "PaymentStatus";

DROP TYPE "PaymentStatus_old";

ALTER TABLE "orders" ALTER COLUMN "payment_status" SET DEFAULT 'PENDING';
