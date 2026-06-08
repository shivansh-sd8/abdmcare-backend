/*
  Warnings:

  - The values [IN_PROGRESS] on the enum `EncounterStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [BILLING_STAFF,RADIOLOGIST] on the enum `UserRole` will be removed. If these variants are still used in the database, this will fail.
  - You are about to alter the column `dailyCharges` on the `admissions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `advancePaid` on the `admissions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `totalAmount` on the `admissions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `paymentCollected` on the `admissions` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `totalRevenue` on the `hospitals` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `amount` on the `payments` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - You are about to alter the column `dailyCharges` on the `wards` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(12,2)`.
  - A unique constraint covering the columns `[hospitalId,code]` on the table `departments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId]` on the table `doctors` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "MedicineCategory" AS ENUM ('TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'OINTMENT', 'DROPS', 'INHALER', 'POWDER', 'SURGICAL', 'CONSUMABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BedType" AS ENUM ('STANDARD', 'ICU', 'ELECTRIC', 'PEDIATRIC', 'BARIATRIC', 'ISOLATION', 'BIRTHING');

-- CreateEnum
CREATE TYPE "CleaningStatus" AS ENUM ('CLEAN', 'NEEDS_CLEANING', 'IN_PROGRESS');

-- AlterEnum
ALTER TYPE "AdmissionStatus" ADD VALUE 'DISCHARGE_READY';

-- AlterEnum
BEGIN;
CREATE TYPE "EncounterStatus_new" AS ENUM ('SCHEDULED', 'CHECKED_IN', 'CONSULTING', 'LAB_PENDING', 'LAB_IN_PROGRESS', 'LAB_COMPLETED', 'SCAN_PENDING', 'SCAN_IN_PROGRESS', 'SCAN_COMPLETED', 'PHARMACY_PENDING', 'PHARMACY_COMPLETED', 'BILLING_PENDING', 'COMPLETED', 'CANCELLED');
ALTER TABLE "encounters" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "encounters" ALTER COLUMN "status" TYPE "EncounterStatus_new" USING ("status"::text::"EncounterStatus_new");
ALTER TYPE "EncounterStatus" RENAME TO "EncounterStatus_old";
ALTER TYPE "EncounterStatus_new" RENAME TO "EncounterStatus";
DROP TYPE "EncounterStatus_old";
ALTER TABLE "encounters" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING ("role"::text::"UserRole_new");
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "UserRole_old";
COMMIT;

-- DropIndex
DROP INDEX "departments_code_key";

-- AlterTable
ALTER TABLE "admissions" ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountApprovedBy" TEXT,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "dailyCharges" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "advancePaid" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "paymentCollected" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "beds" ADD COLUMN     "bedType" "BedType" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "cleaningStatus" "CleaningStatus" NOT NULL DEFAULT 'CLEAN',
ADD COLUMN     "hasMonitor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasOxygen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasSuction" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasVentilator" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastCleanedAt" TIMESTAMP(3),
ADD COLUMN     "lastCleanedBy" TEXT,
ADD COLUMN     "maintenanceFrom" TIMESTAMP(3),
ADD COLUMN     "maintenanceNote" TEXT,
ADD COLUMN     "maintenanceTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "care_contexts" ADD COLUMN     "linkStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "linkToken" TEXT;

-- AlterTable
ALTER TABLE "consents" ADD COLUMN     "requesterHospitalId" TEXT;

-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "breakTimes" JSONB,
ADD COLUMN     "maxPatientsPerDay" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "slotDuration" INTEGER,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "workingHours" JSONB;

-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "discountAmount" DECIMAL(10,2) DEFAULT 0,
ADD COLUMN     "discountApprovedBy" TEXT,
ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "hospitals" ADD COLUMN     "breakTimes" JSONB,
ADD COLUMN     "defaultSlotDuration" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "holidays" JSONB,
ADD COLUMN     "is24x7" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "operatingHours" JSONB,
ALTER COLUMN "totalRevenue" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "isCrossHospital" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "wardId" TEXT;

-- AlterTable
ALTER TABLE "wards" ALTER COLUMN "dailyCharges" SET DATA TYPE DECIMAL(12,2);

-- CreateTable
CREATE TABLE "medicines" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genericName" TEXT,
    "brand" TEXT,
    "manufacturer" TEXT,
    "category" "MedicineCategory" NOT NULL DEFAULT 'TABLET',
    "formulation" TEXT,
    "strength" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "hsnCode" TEXT,
    "gstPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "mrp" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sellingPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 10,
    "schedule" TEXT,
    "storageCondition" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "hospitalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medicines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "quantityReceived" INTEGER NOT NULL,
    "quantityAvailable" INTEGER NOT NULL,
    "costPrice" DECIMAL(10,2) NOT NULL,
    "sellingPrice" DECIMAL(10,2) NOT NULL,
    "mrp" DECIMAL(10,2),
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "batchId" TEXT,
    "hospitalId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reason" TEXT,
    "performedBy" TEXT,
    "balanceAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_transfers" (
    "id" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "fromWardId" TEXT NOT NULL,
    "fromBedId" TEXT,
    "toWardId" TEXT NOT NULL,
    "toBedId" TEXT,
    "reason" TEXT,
    "transferredBy" TEXT,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newDailyCharges" DECIMAL(12,2),
    "hospitalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bed_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "received_shares" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT,
    "abhaNumber" TEXT NOT NULL,
    "abhaAddress" TEXT,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "mobile" TEXT,
    "tokenNumber" TEXT,
    "requestId" TEXT,
    "rawProfile" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medicines_hospitalId_idx" ON "medicines"("hospitalId");

-- CreateIndex
CREATE INDEX "medicines_genericName_idx" ON "medicines"("genericName");

-- CreateIndex
CREATE INDEX "medicines_category_idx" ON "medicines"("category");

-- CreateIndex
CREATE UNIQUE INDEX "medicines_name_hospitalId_key" ON "medicines"("name", "hospitalId");

-- CreateIndex
CREATE INDEX "inventory_batches_medicineId_idx" ON "inventory_batches"("medicineId");

-- CreateIndex
CREATE INDEX "inventory_batches_hospitalId_idx" ON "inventory_batches"("hospitalId");

-- CreateIndex
CREATE INDEX "inventory_batches_expiryDate_idx" ON "inventory_batches"("expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_medicineId_batchNumber_hospitalId_key" ON "inventory_batches"("medicineId", "batchNumber", "hospitalId");

-- CreateIndex
CREATE INDEX "stock_movements_medicineId_idx" ON "stock_movements"("medicineId");

-- CreateIndex
CREATE INDEX "stock_movements_hospitalId_idx" ON "stock_movements"("hospitalId");

-- CreateIndex
CREATE INDEX "stock_movements_type_idx" ON "stock_movements"("type");

-- CreateIndex
CREATE INDEX "stock_movements_createdAt_idx" ON "stock_movements"("createdAt");

-- CreateIndex
CREATE INDEX "bed_transfers_admissionId_idx" ON "bed_transfers"("admissionId");

-- CreateIndex
CREATE INDEX "bed_transfers_hospitalId_idx" ON "bed_transfers"("hospitalId");

-- CreateIndex
CREATE INDEX "received_shares_hospitalId_idx" ON "received_shares"("hospitalId");

-- CreateIndex
CREATE INDEX "received_shares_abhaNumber_idx" ON "received_shares"("abhaNumber");

-- CreateIndex
CREATE INDEX "consents_abdmConsentId_idx" ON "consents"("abdmConsentId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_hospitalId_code_key" ON "departments"("hospitalId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_userId_key" ON "doctors"("userId");

-- CreateIndex
CREATE INDEX "users_departmentId_idx" ON "users"("departmentId");

-- CreateIndex
CREATE INDEX "users_wardId_idx" ON "users"("wardId");

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_requesterHospitalId_fkey" FOREIGN KEY ("requesterHospitalId") REFERENCES "hospitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicines" ADD CONSTRAINT "medicines_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "inventory_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_transfers" ADD CONSTRAINT "bed_transfers_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_transfers" ADD CONSTRAINT "bed_transfers_fromWardId_fkey" FOREIGN KEY ("fromWardId") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_transfers" ADD CONSTRAINT "bed_transfers_fromBedId_fkey" FOREIGN KEY ("fromBedId") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_transfers" ADD CONSTRAINT "bed_transfers_toWardId_fkey" FOREIGN KEY ("toWardId") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_transfers" ADD CONSTRAINT "bed_transfers_toBedId_fkey" FOREIGN KEY ("toBedId") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
