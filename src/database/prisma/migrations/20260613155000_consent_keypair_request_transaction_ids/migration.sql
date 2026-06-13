-- Add requestId / transactionId tracking columns on ConsentKeyPair so the HIU
-- can correlate /data/notification pushes (which carry only a transactionId,
-- never a consent id) back to the keypair that decrypts them.

ALTER TABLE "consent_key_pairs"
  ADD COLUMN "requestId"     TEXT,
  ADD COLUMN "transactionId" TEXT;

CREATE UNIQUE INDEX "consent_key_pairs_requestId_key"     ON "consent_key_pairs"("requestId");
CREATE UNIQUE INDEX "consent_key_pairs_transactionId_key" ON "consent_key_pairs"("transactionId");
CREATE INDEX        "consent_key_pairs_requestId_idx"     ON "consent_key_pairs"("requestId");
CREATE INDEX        "consent_key_pairs_transactionId_idx" ON "consent_key_pairs"("transactionId");
