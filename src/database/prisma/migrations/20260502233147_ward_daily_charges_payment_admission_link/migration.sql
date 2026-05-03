-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "admissionId" TEXT;

-- AlterTable
ALTER TABLE "wards" ADD COLUMN     "dailyCharges" DOUBLE PRECISION NOT NULL DEFAULT 0;
