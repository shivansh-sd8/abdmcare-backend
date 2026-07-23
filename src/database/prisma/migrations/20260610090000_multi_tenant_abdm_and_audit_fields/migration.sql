-- Multi-tenant ABDM credentials, walk-in appointments, broader payment methods,
-- patient clinical demographics, user phone.
--
-- Adds new enum values (AppointmentType.WALK_IN; PaymentMethod.BANK_TRANSFER /
-- CHEQUE / OTHER), per-hospital ABDM bridge columns, and patient/clinical
-- enrichment fields (allergies, medicalHistory, maritalStatus, occupation,
-- middleName).
--
-- All additions are nullable / defaulted so existing rows remain valid.

-- AlterEnum: AppointmentType
ALTER TYPE "AppointmentType" ADD VALUE 'WALK_IN';

-- AlterEnum: PaymentMethod
ALTER TYPE "PaymentMethod" ADD VALUE 'BANK_TRANSFER';
ALTER TYPE "PaymentMethod" ADD VALUE 'CHEQUE';
ALTER TYPE "PaymentMethod" ADD VALUE 'OTHER';

-- AlterTable: hospitals — per-hospital ABDM credentials
ALTER TABLE "hospitals"
  ADD COLUMN "hipName" TEXT,
  ADD COLUMN "hiuName" TEXT,
  ADD COLUMN "abdmClientId" TEXT,
  ADD COLUMN "abdmClientSecret" TEXT,
  ADD COLUMN "abdmCallbackUrl" TEXT,
  ADD COLUMN "hfrFacilityId" TEXT,
  ADD COLUMN "hprId" TEXT;

CREATE UNIQUE INDEX "hospitals_hfrFacilityId_key" ON "hospitals"("hfrFacilityId");

-- AlterTable: users — phone number
ALTER TABLE "users" ADD COLUMN "phone" TEXT;

-- AlterTable: patients — clinical demographics
ALTER TABLE "patients"
  ADD COLUMN "middleName" TEXT,
  ADD COLUMN "maritalStatus" TEXT,
  ADD COLUMN "occupation" TEXT,
  ADD COLUMN "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "medicalHistory" JSONB;
