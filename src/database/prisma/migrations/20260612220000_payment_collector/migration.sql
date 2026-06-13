-- Track who actually collected each payment at the counter, so admin
-- reports & dashboards can attribute revenue to a specific staff member
-- (receptionist / pharmacist / admin) instead of just the patient who paid.
-- `collectedById` is a real FK to users so we can join in service queries
-- without falling back to ad-hoc string matching.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "collectedById" TEXT,
  ADD COLUMN IF NOT EXISTS "collectedAt"   TIMESTAMP(3);

-- ON DELETE SET NULL so deactivating a staff user never voids the payment
-- ledger; the payment row remains intact, just becomes unattributed.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_collectedById_fkey"
  FOREIGN KEY ("collectedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "payments_collectedById_idx"
  ON "payments"("collectedById");

-- Backfill best-effort: if `createdBy` happens to already hold a valid user
-- UUID (true for OPD payments since the encounter service was wiring the
-- current user there), copy it across so historical revenue is still
-- attributable to the staff who actually rang it up. Anything that doesn't
-- resolve to a user just stays NULL.
UPDATE "payments" p
SET "collectedById" = u.id,
    "collectedAt"   = COALESCE(p."paidAt", p."createdAt")
FROM "users" u
WHERE p."collectedById" IS NULL
  AND p."createdBy"      IS NOT NULL
  AND p."createdBy"      = u.id;
