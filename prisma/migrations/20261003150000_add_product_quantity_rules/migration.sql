-- D-012: product-level, admin-configurable purchase quantity rules.
-- Additive and nullable: existing products keep their current behaviour until an admin configures them.
ALTER TABLE "products" ADD COLUMN "min_quantity" DECIMAL(10,3);
ALTER TABLE "products" ADD COLUMN "max_quantity" DECIMAL(10,3);
ALTER TABLE "products" ADD COLUMN "quantity_step" DECIMAL(10,3);
