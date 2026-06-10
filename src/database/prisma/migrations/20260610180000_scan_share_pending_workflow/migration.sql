-- Scan & Share: convert from auto-create to PENDING-first workflow.
--
-- Two model changes in one migration:
--   1. Patient gains `registrationSource` + `profileCompleted` so the front
--      desk can flag rows that came from an ABDM scan and still need intake.
--      Existing rows default to WALK_IN / true (they're considered complete).
--   2. ReceivedShare gains a lifecycle (PENDING → CONVERTED / IGNORED /
--      EXPIRED) and a pointer to the resulting Patient. Existing rows are
--      back-filled to PENDING; if they already have a Patient with the same
--      ABHA number we mark them CONVERTED so they don't re-appear in the queue.

-- ── New enums ────────────────────────────────────────────────────────────
CREATE TYPE "PatientRegistrationSource" AS ENUM (
  'WALK_IN',
  'SCAN_SHARE',
  'ABHA_VERIFY',
  'REFERRAL',
  'IMPORT'
);

CREATE TYPE "ReceivedShareStatus" AS ENUM (
  'PENDING',
  'CONVERTED',
  'IGNORED',
  'EXPIRED'
);

-- ── Patient: registrationSource + profileCompleted ───────────────────────
ALTER TABLE "patients"
  ADD COLUMN IF NOT EXISTS "registrationSource" "PatientRegistrationSource" NOT NULL DEFAULT 'WALK_IN',
  ADD COLUMN IF NOT EXISTS "profileCompleted"   BOOLEAN NOT NULL DEFAULT true;

-- ── ReceivedShare lifecycle columns ──────────────────────────────────────
ALTER TABLE "received_shares"
  ADD COLUMN IF NOT EXISTS "status"             "ReceivedShareStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "convertedPatientId" TEXT,
  ADD COLUMN IF NOT EXISTS "convertedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "convertedById"      TEXT,
  ADD COLUMN IF NOT EXISTS "notes"              TEXT;

CREATE INDEX IF NOT EXISTS "received_shares_status_idx" ON "received_shares"("status");

-- Back-fill: existing rows that already correspond to a real Patient are
-- considered already converted (they were auto-created by the previous
-- handler). Match by abhaNumber within the same hospitalId; null hospitalId
-- rows fall through and stay PENDING (the only safe default).
UPDATE "received_shares" rs
SET
  "status"             = 'CONVERTED',
  "convertedPatientId" = p.id,
  "convertedAt"        = COALESCE(rs."receivedAt", now())
FROM "patients" p
WHERE
  rs."status" = 'PENDING'
  AND rs."hospitalId" IS NOT NULL
  AND p."hospitalId" = rs."hospitalId"
  AND p."abhaNumber" = rs."abhaNumber";

-- And mark every Patient that came from a previous auto-create flow with the
-- correct source — those are easy to identify by the legacy UHID format
-- (`UHID-<epoch>-<5 char>`). Keep profileCompleted = false for these so the
-- "Incomplete profile" banner appears until a receptionist fills them in.
UPDATE "patients"
SET
  "registrationSource" = 'SCAN_SHARE',
  "profileCompleted"   = false
WHERE
  "uhid" ~ '^UHID-[0-9]{10,}-[a-z0-9]{4,6}$';
