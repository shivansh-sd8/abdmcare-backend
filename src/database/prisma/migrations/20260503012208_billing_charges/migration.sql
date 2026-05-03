-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "consultationFee" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "encounter_prescriptions" ADD COLUMN     "price" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "hospitals" ADD COLUMN     "defaultOpdCharge" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "investigations" ADD COLUMN     "admissionId" TEXT,
ADD COLUMN     "amount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "admissionId" TEXT,
ADD COLUMN     "dispensedAt" TIMESTAMP(3),
ADD COLUMN     "dispensedBy" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "totalCharges" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "prescriptions_status_idx" ON "prescriptions"("status");
