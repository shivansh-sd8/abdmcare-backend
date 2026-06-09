import prisma from '../../common/config/database';
import logger from '../../common/config/logger';

// ─────────────────────────────────────────────────────────────────────────────
// HIU Consent Compliance Helpers
//
// Centralises the M3 "purge on revoke / expire" requirement (ABDM HIU Guidelines
// §"Storing Consent Artefacts" + §"Display Health Records" — once a consent is
// no longer GRANTED the HIU MUST stop using it AND wipe any decryption material
// and any health records pulled under it).
//
// Used by:
//   - HIU on-notify callback (status REVOKED / EXPIRED arriving from CM)
//   - Consent expiry sweeper (BullMQ repeatable job)
//   - Local "Cancel" action in consent.service.revokeConsent
// ─────────────────────────────────────────────────────────────────────────────

interface PurgeResult {
  consentRowId: string;
  abdmConsentId: string | null;
  externalRecordsDeleted: number;
  keyPairsDeleted: number;
  alreadyPurged: boolean;
}

/**
 * Wipe the decryption keypair and every ExternalHealthRecord stored under the
 * given consent row, then mark the consent as purged. Idempotent — calling it
 * twice is a no-op the second time. Always succeeds; never throws (the caller
 * must still ACK the upstream callback).
 */
export async function purgeConsentData(consentRowId: string): Promise<PurgeResult> {
  const consent = await prisma.consent.findUnique({
    where: { id: consentRowId },
    select: { id: true, abdmConsentId: true, purgedAt: true, status: true, consentId: true },
  });

  if (!consent) {
    return {
      consentRowId,
      abdmConsentId: null,
      externalRecordsDeleted: 0,
      keyPairsDeleted: 0,
      alreadyPurged: true,
    };
  }

  if (consent.purgedAt) {
    return {
      consentRowId,
      abdmConsentId: consent.abdmConsentId,
      externalRecordsDeleted: 0,
      keyPairsDeleted: 0,
      alreadyPurged: true,
    };
  }

  // Records are stored keyed on Consent.consentId (local) AND/OR the ABDM
  // consentId (we historically stored both). Wipe all that match either.
  const orClauses: any[] = [{ consentId: consent.id }, { consentId: consent.consentId }];
  if (consent.abdmConsentId) orClauses.push({ consentId: consent.abdmConsentId });

  const [recordsDel, keyPairsDel] = await prisma.$transaction([
    prisma.externalHealthRecord.deleteMany({ where: { OR: orClauses } }),
    consent.abdmConsentId
      ? prisma.consentKeyPair.deleteMany({ where: { consentId: consent.abdmConsentId } })
      : prisma.consentKeyPair.deleteMany({ where: { consentId: '__none__' } }),
    prisma.consent.update({
      where: { id: consent.id },
      data: { purgedAt: new Date() },
    }),
  ]);

  // Audit trail (best-effort; missing AuditLog table fields shouldn't block purge).
  try {
    await prisma.auditLog.create({
      data: {
        action: 'CONSENT_PURGED',
        module: 'HIU',
        userType: 'SYSTEM',
        resourceType: 'CONSENT',
        resourceId: consent.id,
        status: 'SUCCESS',
        requestData: {
          status: consent.status,
          abdmConsentId: consent.abdmConsentId,
          recordsDeleted: recordsDel.count,
          keyPairsDeleted: keyPairsDel.count,
        },
      },
    });
  } catch (err: any) {
    logger.warn('purgeConsentData: audit log write failed', { message: err?.message });
  }

  logger.info('HIU: consent data purged', {
    consentRowId: consent.id,
    abdmConsentId: consent.abdmConsentId,
    recordsDeleted: recordsDel.count,
    keyPairsDeleted: keyPairsDel.count,
    finalStatus: consent.status,
  });

  return {
    consentRowId: consent.id,
    abdmConsentId: consent.abdmConsentId,
    externalRecordsDeleted: recordsDel.count,
    keyPairsDeleted: keyPairsDel.count,
    alreadyPurged: false,
  };
}

/**
 * Find every consent row that maps to a given ABDM consent id (local or
 * artefact id) and purge each. Used by inbound callbacks where only the ABDM
 * id is known.
 */
export async function purgeByAbdmConsentId(abdmConsentId: string): Promise<PurgeResult[]> {
  const matches = await prisma.consent.findMany({
    where: {
      OR: [
        { abdmConsentId },
        { consentId: abdmConsentId },
        { abdmRequestId: abdmConsentId },
      ],
    },
    select: { id: true },
  });
  const results: PurgeResult[] = [];
  for (const row of matches) {
    results.push(await purgeConsentData(row.id));
  }
  return results;
}

/**
 * Returns the consent row (and its grant window) only when the consent is in a
 * state where the HIU is still authorised to USE the data. Anything that has
 * ever been REVOKED / DENIED / EXPIRED returns null. The caller must treat a
 * null result as "no data may be returned".
 */
export async function loadActiveConsent(consentRowId: string) {
  const consent = await prisma.consent.findUnique({
    where: { id: consentRowId },
    select: {
      id: true,
      consentId: true,
      abdmConsentId: true,
      status: true,
      grantedAt: true,
      expiresAt: true,
      purgedAt: true,
      hiTypes: true,
      dateRange: true,
      requesterHospitalId: true,
      patientId: true,
    },
  });
  if (!consent) return null;
  if (consent.status !== 'GRANTED') return null;
  if (consent.purgedAt) return null;
  if (consent.expiresAt && consent.expiresAt.getTime() < Date.now()) return null;
  return consent;
}
