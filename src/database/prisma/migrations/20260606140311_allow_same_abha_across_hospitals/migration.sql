-- Allow the same person (same ABHA / mobile) to be registered as a Patient
-- at multiple hospitals. ABHA is a national identity; the Patient row is
-- hospital-local. Uniqueness moves from global to per-hospital.

-- Drop the global single-column unique indexes on Patient.
DROP INDEX IF EXISTS "patients_abhaId_key";
DROP INDEX IF EXISTS "patients_abhaNumber_key";
DROP INDEX IF EXISTS "patients_mobile_key";

-- Add per-hospital composite unique indexes.
-- Note: rows where hospitalId IS NULL are treated as distinct by Postgres,
-- which is the intended behavior for legacy / super-admin records.
CREATE UNIQUE INDEX "patients_hospital_abhaId_unique"     ON "patients" ("hospitalId", "abhaId");
CREATE UNIQUE INDEX "patients_hospital_abhaNumber_unique" ON "patients" ("hospitalId", "abhaNumber");
CREATE UNIQUE INDEX "patients_hospital_mobile_unique"     ON "patients" ("hospitalId", "mobile");
