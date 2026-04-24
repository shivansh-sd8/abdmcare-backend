/*
  Warnings:

  - You are about to drop the column `hospitalId` on the `patients` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[hipId]` on the table `hospitals` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[hiuId]` on the table `hospitals` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[primaryAdminId]` on the table `hospitals` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[abhaNumber]` on the table `patients` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "HospitalPlan" AS ENUM ('FREE', 'BASIC', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "HospitalStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TRIAL', 'EXPIRED');

-- DropForeignKey
ALTER TABLE "patients" DROP CONSTRAINT "patients_hospitalId_fkey";

-- DropIndex
DROP INDEX "patients_hospitalId_idx";

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "hospitalId" TEXT;

-- AlterTable
ALTER TABLE "hospitals" ADD COLUMN     "abdmEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hipId" TEXT,
ADD COLUMN     "hiuId" TEXT,
ADD COLUMN     "maxPatients" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "maxUsers" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "plan" "HospitalPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "primaryAdminId" TEXT,
ADD COLUMN     "status" "HospitalStatus" NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "subscriptionEndsAt" TIMESTAMP(3),
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "patients" DROP COLUMN "hospitalId",
ADD COLUMN     "abhaNumber" TEXT;

-- CreateIndex
CREATE INDEX "departments_hospitalId_idx" ON "departments"("hospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "hospitals_hipId_key" ON "hospitals"("hipId");

-- CreateIndex
CREATE UNIQUE INDEX "hospitals_hiuId_key" ON "hospitals"("hiuId");

-- CreateIndex
CREATE UNIQUE INDEX "hospitals_primaryAdminId_key" ON "hospitals"("primaryAdminId");

-- CreateIndex
CREATE INDEX "hospitals_status_idx" ON "hospitals"("status");

-- CreateIndex
CREATE INDEX "hospitals_plan_idx" ON "hospitals"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "patients_abhaNumber_key" ON "patients"("abhaNumber");

-- CreateIndex
CREATE INDEX "patients_abhaNumber_idx" ON "patients"("abhaNumber");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
