/*
  Warnings:

  - You are about to drop the column `address` on the `hospitals` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `hospitals` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[registrationNumber]` on the table `hospitals` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `addressLine1` to the `hospitals` table without a default value. This is not possible if the table is not empty.
  - Made the column `city` on table `hospitals` required. This step will fail if there are existing NULL values in that column.
  - Made the column `state` on table `hospitals` required. This step will fail if there are existing NULL values in that column.
  - Made the column `pincode` on table `hospitals` required. This step will fail if there are existing NULL values in that column.
  - Made the column `phone` on table `hospitals` required. This step will fail if there are existing NULL values in that column.
  - Made the column `email` on table `hospitals` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "HospitalType" AS ENUM ('HOSPITAL', 'CLINIC', 'NURSING_HOME', 'DIAGNOSTIC_CENTER', 'POLYCLINIC', 'SPECIALTY_CENTER', 'MULTI_SPECIALTY', 'SUPER_SPECIALTY');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- AlterTable
ALTER TABLE "hospitals" DROP COLUMN "address",
ADD COLUMN     "abdmRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "addressLine1" TEXT NOT NULL,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "alternatePhone" TEXT,
ADD COLUMN     "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'India',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "emergencyBeds" INTEGER DEFAULT 0,
ADD COLUMN     "establishedYear" INTEGER,
ADD COLUMN     "gstNumber" TEXT,
ADD COLUMN     "icuBeds" INTEGER DEFAULT 0,
ADD COLUMN     "isVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "landmark" TEXT,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "lastPaymentDate" TIMESTAMP(3),
ADD COLUMN     "licenseNumber" TEXT,
ADD COLUMN     "maxDoctors" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "maxStorage" INTEGER NOT NULL DEFAULT 1024,
ADD COLUMN     "nextBillingDate" TIMESTAMP(3),
ADD COLUMN     "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingStep" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "operationTheaters" INTEGER DEFAULT 0,
ADD COLUMN     "ownerEmail" TEXT,
ADD COLUMN     "ownerName" TEXT,
ADD COLUMN     "ownerPhone" TEXT,
ADD COLUMN     "panNumber" TEXT,
ADD COLUMN     "registrationNumber" TEXT,
ADD COLUMN     "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "subscriptionStartedAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
ADD COLUMN     "totalBeds" INTEGER DEFAULT 0,
ADD COLUMN     "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "trialStartedAt" TIMESTAMP(3),
ADD COLUMN     "type" "HospitalType" NOT NULL DEFAULT 'HOSPITAL',
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedBy" TEXT,
ADD COLUMN     "website" TEXT,
ALTER COLUMN "city" SET NOT NULL,
ALTER COLUMN "state" SET NOT NULL,
ALTER COLUMN "pincode" SET NOT NULL,
ALTER COLUMN "phone" SET NOT NULL,
ALTER COLUMN "email" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "hospitals_email_key" ON "hospitals"("email");

-- CreateIndex
CREATE UNIQUE INDEX "hospitals_registrationNumber_key" ON "hospitals"("registrationNumber");

-- CreateIndex
CREATE INDEX "hospitals_email_idx" ON "hospitals"("email");

-- CreateIndex
CREATE INDEX "hospitals_isActive_idx" ON "hospitals"("isActive");
