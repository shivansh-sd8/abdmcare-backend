-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EncounterStatus" ADD VALUE 'CHECKED_IN';
ALTER TYPE "EncounterStatus" ADD VALUE 'CONSULTING';
ALTER TYPE "EncounterStatus" ADD VALUE 'LAB_PENDING';
ALTER TYPE "EncounterStatus" ADD VALUE 'LAB_IN_PROGRESS';
ALTER TYPE "EncounterStatus" ADD VALUE 'LAB_COMPLETED';
ALTER TYPE "EncounterStatus" ADD VALUE 'SCAN_PENDING';
ALTER TYPE "EncounterStatus" ADD VALUE 'SCAN_IN_PROGRESS';
ALTER TYPE "EncounterStatus" ADD VALUE 'SCAN_COMPLETED';
ALTER TYPE "EncounterStatus" ADD VALUE 'PHARMACY_PENDING';
ALTER TYPE "EncounterStatus" ADD VALUE 'PHARMACY_COMPLETED';
ALTER TYPE "EncounterStatus" ADD VALUE 'BILLING_PENDING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'BILLING_STAFF';
ALTER TYPE "UserRole" ADD VALUE 'RADIOLOGIST';

-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "billGenerated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consultationFee" DECIMAL(10,2),
ADD COLUMN     "labCharges" DECIMAL(10,2),
ADD COLUMN     "labResults" JSONB,
ADD COLUMN     "labTestsCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "labTestsOrdered" JSONB,
ADD COLUMN     "medicineCharges" DECIMAL(10,2),
ADD COLUMN     "medicinesDispensed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentStatus" TEXT,
ADD COLUMN     "scanCharges" DECIMAL(10,2),
ADD COLUMN     "scanResults" JSONB,
ADD COLUMN     "scansCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scansOrdered" JSONB,
ADD COLUMN     "totalAmount" DECIMAL(10,2);
