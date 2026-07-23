-- CreateEnum
CREATE TYPE "AbhaProfileStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'DELETED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConsentPurpose" ADD VALUE 'HEALTHCARE_PAYMENT';
ALTER TYPE "ConsentPurpose" ADD VALUE 'SELF_REQUESTED';
ALTER TYPE "ConsentPurpose" ADD VALUE 'HEALTHCARE_QUALITY_AUDIT';

-- AlterTable
ALTER TABLE "abha_records" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "profileStatus" "AbhaProfileStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "consents" ADD COLUMN     "artefactBody" JSONB,
ADD COLUMN     "artefactFetchedAt" TIMESTAMP(3),
ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "external_health_records" ADD COLUMN     "hospitalId" TEXT;

-- CreateTable
CREATE TABLE "immunizations" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "vaccineName" TEXT NOT NULL,
    "vaccineCode" TEXT,
    "manufacturer" TEXT,
    "lotNumber" TEXT,
    "expiryDate" TIMESTAMP(3),
    "doseNumber" INTEGER,
    "totalDoses" INTEGER,
    "site" TEXT,
    "route" TEXT,
    "doseQuantity" DECIMAL(8,3),
    "doseUnit" TEXT,
    "administeredAt" TIMESTAMP(3) NOT NULL,
    "administeredBy" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "hospitalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "immunizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "immunizations_patientId_idx" ON "immunizations"("patientId");

-- CreateIndex
CREATE INDEX "immunizations_encounterId_idx" ON "immunizations"("encounterId");

-- CreateIndex
CREATE INDEX "immunizations_administeredAt_idx" ON "immunizations"("administeredAt");

-- CreateIndex
CREATE INDEX "abha_records_profileStatus_idx" ON "abha_records"("profileStatus");

-- CreateIndex
CREATE INDEX "consents_expiresAt_idx" ON "consents"("expiresAt");

-- CreateIndex
CREATE INDEX "external_health_records_hospitalId_idx" ON "external_health_records"("hospitalId");

-- AddForeignKey
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
