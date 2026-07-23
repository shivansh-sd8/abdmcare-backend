-- CreateTable
CREATE TABLE "consent_key_pairs" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_key_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_health_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "consentId" TEXT,
    "sourceHipId" TEXT,
    "sourceHipName" TEXT,
    "recordType" TEXT NOT NULL,
    "recordDate" TIMESTAMP(3),
    "rawBundle" JSONB NOT NULL,
    "parsedData" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_health_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consent_key_pairs_consentId_key" ON "consent_key_pairs"("consentId");

-- CreateIndex
CREATE INDEX "consent_key_pairs_consentId_idx" ON "consent_key_pairs"("consentId");

-- CreateIndex
CREATE INDEX "external_health_records_patientId_idx" ON "external_health_records"("patientId");

-- CreateIndex
CREATE INDEX "external_health_records_consentId_idx" ON "external_health_records"("consentId");

-- AddForeignKey
ALTER TABLE "external_health_records" ADD CONSTRAINT "external_health_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
