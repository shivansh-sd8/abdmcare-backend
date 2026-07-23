-- AlterTable: add the care-context dedup key. Nullable so existing rows
-- backfill to NULL. Postgres treats NULLs as distinct under a unique index,
-- so pre-existing duplicate rows (which all get NULL here) will NOT violate
-- the constraint added below.
ALTER TABLE "external_health_records" ADD COLUMN "careContextReference" TEXT;

-- CreateIndex: natural dedup key so re-pulling the same care context under the
-- same consent upserts instead of appending a duplicate.
CREATE UNIQUE INDEX "external_health_records_consentId_careContextReference_key" ON "external_health_records"("consentId", "careContextReference");
