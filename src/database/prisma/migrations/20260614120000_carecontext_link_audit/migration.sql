-- Link-audit detail for care contexts (surfaced in the ABDM linking UI).
ALTER TABLE "care_contexts" ADD COLUMN "hiType" TEXT;
ALTER TABLE "care_contexts" ADD COLUMN "linkedAt" TIMESTAMP(3);
ALTER TABLE "care_contexts" ADD COLUMN "linkError" TEXT;
