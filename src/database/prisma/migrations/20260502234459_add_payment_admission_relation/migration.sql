-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "admissionId" TEXT;

-- CreateIndex
CREATE INDEX "payments_admissionId_idx" ON "payments"("admissionId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
