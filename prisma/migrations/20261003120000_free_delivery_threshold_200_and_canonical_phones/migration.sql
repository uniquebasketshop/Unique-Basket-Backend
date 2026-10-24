-- D-009: free delivery threshold is ₹200 (was the ₹499 schema default).
ALTER TABLE "delivery_settings" ALTER COLUMN "free_delivery_threshold" SET DEFAULT 200.00;

-- Settings rows still carrying the old default move to the confirmed value.
-- Rows an admin set to any other value are left unchanged.
UPDATE "delivery_settings"
SET "free_delivery_threshold" = 200.00, "updated_at" = CURRENT_TIMESTAMP
WHERE "free_delivery_threshold" = 499.00;

-- D-008: customer phone numbers are stored as +91XXXXXXXXXX.
-- Rewrite legacy formats (9876543210, 919876543210, 09876543210, spaced/hyphenated)
-- only when the result is a valid Indian mobile number and no other user already has it.
-- No rows are deleted; anything that cannot be normalized safely is left untouched.
WITH candidates AS (
  SELECT
    "id",
    regexp_replace("phone", '[\s\-().]', '', 'g') AS compact
  FROM "users"
),
normalized AS (
  SELECT
    "id",
    CASE
      WHEN compact ~ '^\+91[6-9][0-9]{9}$' THEN compact
      WHEN compact ~ '^91[6-9][0-9]{9}$' THEN '+' || compact
      WHEN compact ~ '^0[6-9][0-9]{9}$' THEN '+91' || substring(compact FROM 2)
      WHEN compact ~ '^[6-9][0-9]{9}$' THEN '+91' || compact
      ELSE NULL
    END AS canonical
  FROM candidates
),
safe AS (
  SELECT n."id", n.canonical
  FROM normalized n
  JOIN "users" u ON u."id" = n."id"
  WHERE n.canonical IS NOT NULL
    AND n.canonical <> u."phone"
    AND NOT EXISTS (SELECT 1 FROM "users" o WHERE o."phone" = n.canonical AND o."id" <> n."id")
    AND (SELECT count(*) FROM normalized d WHERE d.canonical = n.canonical) = 1
)
UPDATE "users" u
SET "phone" = safe.canonical, "updated_at" = CURRENT_TIMESTAMP
FROM safe
WHERE u."id" = safe."id";
