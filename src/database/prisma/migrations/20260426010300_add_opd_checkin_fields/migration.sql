/*
  Warnings:

  - A unique constraint covering the columns `[opdCardNumber]` on the table `appointments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[encounterId]` on the table `appointments` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "encounterId" TEXT,
ADD COLUMN     "opdCardNumber" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "appointments_opdCardNumber_key" ON "appointments"("opdCardNumber");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_encounterId_key" ON "appointments"("encounterId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
