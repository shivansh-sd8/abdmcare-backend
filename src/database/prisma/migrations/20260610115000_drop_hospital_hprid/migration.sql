-- Drop the unused `hprId` column from the Hospital table.
--
-- Rationale: HPR (Healthcare Professional Registry) is by spec a *per-doctor*
-- registry — every individual clinician has their own HPR ID. The Doctor
-- table already carries `hprId` (used by the FHIR Practitioner builder and
-- doctor lookups). The Hospital column was introduced earlier as a
-- placeholder, was only ever WRITTEN on onboarding (never read), and confuses
-- the data model. Per-facility registry IDs continue to live as `hfrFacilityId`,
-- `hipId`, and `hiuId` on the Hospital row.
ALTER TABLE "hospitals" DROP COLUMN IF EXISTS "hprId";
