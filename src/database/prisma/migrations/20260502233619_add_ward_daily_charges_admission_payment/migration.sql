/*
  Warnings:

  - You are about to drop the column `admissionId` on the `payments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "admissions" ADD COLUMN     "paymentCollected" DOUBLE PRECISION,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "paymentSettledAt" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" TEXT DEFAULT 'PENDING',
ADD COLUMN     "transactionRef" TEXT;

-- AlterTable
ALTER TABLE "payments" DROP COLUMN "admissionId";
