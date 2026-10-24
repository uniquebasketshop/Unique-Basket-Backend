-- AlterTable
ALTER TABLE "delivery_settings" ADD COLUMN     "order_cutoff_time" VARCHAR(10) NOT NULL DEFAULT '19:00',
ADD COLUMN     "pickup_closing_time" VARCHAR(10) NOT NULL DEFAULT '21:00',
ADD COLUMN     "store_opening_time" VARCHAR(10) NOT NULL DEFAULT '09:00',
ADD COLUMN     "weekly_closed_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "order_cutoff_time" VARCHAR(10) NOT NULL DEFAULT '19:00',
ADD COLUMN     "use_custom_timings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "weekly_closed_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "store_holidays" (
    "id" UUID NOT NULL,
    "store_id" UUID,
    "date" DATE NOT NULL,
    "note" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_holidays_date_idx" ON "store_holidays"("date");

-- AddForeignKey
ALTER TABLE "store_holidays" ADD CONSTRAINT "store_holidays_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
