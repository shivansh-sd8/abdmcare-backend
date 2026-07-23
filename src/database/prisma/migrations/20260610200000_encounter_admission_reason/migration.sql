-- Encounter: capture the *reason* a doctor flagged admission so the receptionist / admin doesn't have to ask again.
ALTER TABLE "encounters" ADD COLUMN IF NOT EXISTS "admissionReason" TEXT;
