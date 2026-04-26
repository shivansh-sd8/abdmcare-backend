-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderPriority" AS ENUM ('ROUTINE', 'URGENT', 'STAT');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReferralUrgency" AS ENUM ('ROUTINE', 'URGENT', 'EMERGENCY');

-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "admissionRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "finalDiagnosis" TEXT,
ADD COLUMN     "followUpDate" TIMESTAMP(3),
ADD COLUMN     "historyOfPresentIllness" TEXT,
ADD COLUMN     "pastMedicalHistory" TEXT,
ADD COLUMN     "physicalExamination" TEXT,
ADD COLUMN     "provisionalDiagnosis" TEXT,
ADD COLUMN     "referralRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "encounter_prescriptions" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "medicineName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "instructions" TEXT,
    "quantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encounter_prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_orders" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "testType" TEXT,
    "priority" "OrderPriority" NOT NULL DEFAULT 'ROUTINE',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "results" JSONB,
    "resultNotes" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "referredToDoctorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "urgency" "ReferralUrgency" NOT NULL DEFAULT 'ROUTINE',
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "appointmentDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_prescriptions_encounterId_idx" ON "encounter_prescriptions"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "lab_orders_orderId_key" ON "lab_orders"("orderId");

-- CreateIndex
CREATE INDEX "lab_orders_encounterId_idx" ON "lab_orders"("encounterId");

-- CreateIndex
CREATE INDEX "lab_orders_status_idx" ON "lab_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referralId_key" ON "referrals"("referralId");

-- CreateIndex
CREATE INDEX "referrals_encounterId_idx" ON "referrals"("encounterId");

-- CreateIndex
CREATE INDEX "referrals_referredToDoctorId_idx" ON "referrals"("referredToDoctorId");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- AddForeignKey
ALTER TABLE "encounter_prescriptions" ADD CONSTRAINT "encounter_prescriptions_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredToDoctorId_fkey" FOREIGN KEY ("referredToDoctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
