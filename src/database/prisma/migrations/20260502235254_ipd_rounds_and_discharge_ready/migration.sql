-- AlterTable
ALTER TABLE "admissions" ADD COLUMN     "dischargeReadyAt" TIMESTAMP(3),
ADD COLUMN     "dischargeReadyBy" TEXT;

-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "admissionId" TEXT;

-- CreateIndex
CREATE INDEX "encounters_admissionId_idx" ON "encounters"("admissionId");

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
