-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_address_snapshot" JSONB;


-- Backfill: snapshot the current address for existing orders that still reference one
UPDATE "orders" AS o
SET "delivery_address_snapshot" = jsonb_build_object(
    'id', a."id",
    'title', a."title",
    'addressLine', a."address_line",
    'city', a."city",
    'state', a."state",
    'pincode', a."pincode",
    'latitude', a."latitude",
    'longitude', a."longitude"
)
FROM "user_addresses" AS a
WHERE o."address_id" = a."id"
  AND o."delivery_address_snapshot" IS NULL;
