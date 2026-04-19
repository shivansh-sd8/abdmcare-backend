-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "EncounterType" AS ENUM ('OPD', 'IPD', 'EMERGENCY', 'TELECONSULTATION');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('REQUESTED', 'GRANTED', 'DENIED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('CARE_MANAGEMENT', 'BREAK_THE_GLASS', 'PUBLIC_HEALTH', 'DISEASE_SPECIFIC_HEALTHCARE_RESEARCH');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('PATIENT', 'DOCTOR', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST');

-- CreateEnum
CREATE TYPE "FacilityType" AS ENUM ('HOSPITAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'PHARMACY');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('OPD', 'TELECONSULTATION', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "uhid" TEXT NOT NULL,
    "abhaId" TEXT,
    "abhaAddress" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "dob" TIMESTAMP(3) NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT,
    "address" JSONB NOT NULL,
    "bloodGroup" TEXT,
    "emergencyContact" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abha_records" (
    "id" TEXT NOT NULL,
    "abhaNumber" TEXT NOT NULL,
    "abhaAddress" TEXT,
    "patientId" TEXT NOT NULL,
    "aadhaarLinked" BOOLEAN NOT NULL DEFAULT false,
    "mobileLinked" BOOLEAN NOT NULL DEFAULT false,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "profileData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abha_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" TEXT NOT NULL,
    "hprId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "specialization" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "registrationNo" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "facilityId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facilities" (
    "id" TEXT NOT NULL,
    "hfrId" TEXT,
    "name" TEXT NOT NULL,
    "type" "FacilityType" NOT NULL,
    "address" JSONB NOT NULL,
    "contact" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounters" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "type" "EncounterType" NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "chiefComplaint" TEXT NOT NULL,
    "diagnosis" TEXT,
    "prescription" JSONB,
    "vitalSigns" JSONB,
    "notes" TEXT,
    "status" "EncounterStatus" NOT NULL DEFAULT 'SCHEDULED',
    "visitDate" TIMESTAMP(3) NOT NULL,
    "careContextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emr_records" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "fhirData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emr_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_contexts" (
    "id" TEXT NOT NULL,
    "careContextId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "hipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterName" TEXT,
    "purpose" "ConsentPurpose" NOT NULL,
    "hiTypes" TEXT[],
    "dateRange" JSONB NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'REQUESTED',
    "grantedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "abdmRequestId" TEXT,
    "abdmConsentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 30,
    "type" "AppointmentType" NOT NULL DEFAULT 'OPD',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "userId" TEXT,
    "userType" "UserType" NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestData" JSONB,
    "responseData" JSONB,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abdm_transactions" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "requestId" TEXT,
    "apiEndpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "statusCode" INTEGER,
    "success" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "duration" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abdm_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_uhid_key" ON "patients"("uhid");

-- CreateIndex
CREATE UNIQUE INDEX "patients_abhaId_key" ON "patients"("abhaId");

-- CreateIndex
CREATE UNIQUE INDEX "patients_mobile_key" ON "patients"("mobile");

-- CreateIndex
CREATE INDEX "patients_abhaId_idx" ON "patients"("abhaId");

-- CreateIndex
CREATE INDEX "patients_mobile_idx" ON "patients"("mobile");

-- CreateIndex
CREATE INDEX "patients_uhid_idx" ON "patients"("uhid");

-- CreateIndex
CREATE UNIQUE INDEX "abha_records_abhaNumber_key" ON "abha_records"("abhaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "abha_records_patientId_key" ON "abha_records"("patientId");

-- CreateIndex
CREATE INDEX "abha_records_abhaNumber_idx" ON "abha_records"("abhaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_hprId_key" ON "doctors"("hprId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_registrationNo_key" ON "doctors"("registrationNo");

-- CreateIndex
CREATE INDEX "doctors_hprId_idx" ON "doctors"("hprId");

-- CreateIndex
CREATE INDEX "doctors_registrationNo_idx" ON "doctors"("registrationNo");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "facilities_hfrId_key" ON "facilities"("hfrId");

-- CreateIndex
CREATE INDEX "facilities_hfrId_idx" ON "facilities"("hfrId");

-- CreateIndex
CREATE UNIQUE INDEX "encounters_encounterId_key" ON "encounters"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "encounters_careContextId_key" ON "encounters"("careContextId");

-- CreateIndex
CREATE INDEX "encounters_patientId_idx" ON "encounters"("patientId");

-- CreateIndex
CREATE INDEX "encounters_doctorId_idx" ON "encounters"("doctorId");

-- CreateIndex
CREATE INDEX "encounters_visitDate_idx" ON "encounters"("visitDate");

-- CreateIndex
CREATE INDEX "emr_records_encounterId_idx" ON "emr_records"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "care_contexts_careContextId_key" ON "care_contexts"("careContextId");

-- CreateIndex
CREATE UNIQUE INDEX "care_contexts_encounterId_key" ON "care_contexts"("encounterId");

-- CreateIndex
CREATE INDEX "care_contexts_patientId_idx" ON "care_contexts"("patientId");

-- CreateIndex
CREATE INDEX "care_contexts_careContextId_idx" ON "care_contexts"("careContextId");

-- CreateIndex
CREATE UNIQUE INDEX "consents_consentId_key" ON "consents"("consentId");

-- CreateIndex
CREATE INDEX "consents_patientId_idx" ON "consents"("patientId");

-- CreateIndex
CREATE INDEX "consents_status_idx" ON "consents"("status");

-- CreateIndex
CREATE INDEX "consents_consentId_idx" ON "consents"("consentId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_appointmentId_key" ON "appointments"("appointmentId");

-- CreateIndex
CREATE INDEX "appointments_patientId_idx" ON "appointments"("patientId");

-- CreateIndex
CREATE INDEX "appointments_doctorId_idx" ON "appointments"("doctorId");

-- CreateIndex
CREATE INDEX "appointments_scheduledAt_idx" ON "appointments"("scheduledAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_module_idx" ON "audit_logs"("module");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "abdm_transactions_transactionId_key" ON "abdm_transactions"("transactionId");

-- CreateIndex
CREATE INDEX "abdm_transactions_timestamp_idx" ON "abdm_transactions"("timestamp");

-- CreateIndex
CREATE INDEX "abdm_transactions_success_idx" ON "abdm_transactions"("success");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- AddForeignKey
ALTER TABLE "abha_records" ADD CONSTRAINT "abha_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emr_records" ADD CONSTRAINT "emr_records_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_contexts" ADD CONSTRAINT "care_contexts_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_contexts" ADD CONSTRAINT "care_contexts_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
