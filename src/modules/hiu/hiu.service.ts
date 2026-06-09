import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';
import { config } from '../../common/config/index';
import { parseFHIRBundle } from '../../common/utils/fhir/fhir-parser';
import { rethrowServiceError } from '../../common/utils/serviceErrors';

// ─────────────────────────────────────────────────────────────────────────────
// HIU Service V3 (M3 — Health Information User)
// ─────────────────────────────────────────────────────────────────────────────

const aesKey = config.encryption.aesKey;
const useAes = aesKey && aesKey.length === 32;

function encryptPrivateKey(plainKey: string): string {
  if (!useAes) return plainKey;
  const { encrypted, iv } = EncryptionService.encryptWithAES(plainKey, aesKey);
  return `${iv}:${encrypted}`;
}

function decryptPrivateKey(stored: string): string {
  if (!useAes || !stored.includes(':')) return stored;
  const [iv, encrypted] = stored.split(':');
  return EncryptionService.decryptWithAES(encrypted, iv, aesKey);
}

export class HiuService {
  /**
   * Request health information from HIP via ABDM
   * POST /api/hiecm/data-flow/v3/health-information/request
   */
  async requestHealthInformation(data: {
    consentId: string;
    dateRangeFrom: string;
    dateRangeTo: string;
    dataPushUrl?: string;
  }) {
    try {
      logger.info('HIU: Requesting health information', { consentId: data.consentId });

      const consent = await prisma.consent.findUnique({
        where: { id: data.consentId },
        include: { patient: { include: { abhaRecord: true } } },
      });

      if (!consent) throw new AppError('Consent not found', 404);
      if (consent.status !== 'GRANTED') throw new AppError('Consent not granted', 403);
      if (!consent.abdmConsentId) throw new AppError('ABDM consent ID not available', 400);

      const ecdhKeyPair = EncryptionService.generateECDHKeyPair();

      await prisma.consentKeyPair.upsert({
        where: { consentId: consent.abdmConsentId },
        update: {
          privateKey: encryptPrivateKey(ecdhKeyPair.privateKey),
          nonce: ecdhKeyPair.nonce,
        },
        create: {
          consentId: consent.abdmConsentId,
          privateKey: encryptPrivateKey(ecdhKeyPair.privateKey),
          nonce: ecdhKeyPair.nonce,
        },
      });

      const requestPayload = {
        hiRequest: {
          consent: { id: consent.abdmConsentId },
          dateRange: { from: data.dateRangeFrom, to: data.dateRangeTo },
          dataPushUrl: data.dataPushUrl || `${abdmConfig.callbackUrl}/api/v3/hiu/data/notification`,
          keyMaterial: {
            cryptoAlg: 'ECDH',
            curve: 'Curve25519',
            dhPublicKey: {
              expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              parameters: 'Curve25519/32byte random key',
              keyValue: ecdhKeyPair.publicKey,
            },
            nonce: ecdhKeyPair.nonce,
          },
        },
      };

      await abdmClient.post(abdmConfig.endpoints.hiu.healthInfoRequest, requestPayload);

      logger.info('HIU: Health information request sent', { consentId: consent.consentId });
      return { success: true, message: 'Health information request sent successfully' };
    } catch (error: any) {
      logger.error('HIU: Failed to request health information', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Handle consent notification for HIU
   * POST /api/hiecm/consent/v3/request/hiu/on-notify
   */
  async consentOnNotify(params: { requestId: string; consentIds: Array<{ status: string; consentId: string }> }) {
    try {
      await abdmClient.post(abdmConfig.endpoints.hiu.consentOnNotify, {
        acknowledgement: params.consentIds.map(c => ({ status: c.status, consentId: c.consentId })),
        response: { requestId: params.requestId },
      });
      logger.info('HIU: consent on-notify acknowledged');
    } catch (error: any) {
      logger.error('HIU: consent on-notify failed', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Send data flow completion notification
   * POST /api/hiecm/data-flow/v3/health-information/notify
   */
  async dataFlowNotify(params: {
    consentId: string;
    transactionId: string;
    status: string;
    hipId?: string;
    statusResponses?: Array<{ careContextReference: string; hiStatus: string; description?: string }>;
  }) {
    try {
      // Per ABDM M3 data-flow notify spec, statusNotification.hipId is REQUIRED
      // (the HIP that provided the data) and statusResponses carries per-care-
      // context delivery status. In the sandbox this instance is both HIP+HIU,
      // so default hipId to our configured HIP id when not supplied.
      const hipId = params.hipId || abdmConfig.hip.id;
      await abdmClient.post(abdmConfig.endpoints.hiu.dataFlowNotify, {
        notification: {
          consentId: params.consentId,
          transactionId: params.transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIU', id: abdmConfig.hiu.id },
          statusNotification: {
            sessionStatus: params.status,
            hipId,
            statusResponses: params.statusResponses || [],
          },
        },
      });
      logger.info('HIU: data flow notify sent', { transactionId: params.transactionId, hipId });
    } catch (error: any) {
      logger.error('HIU: data flow notify failed', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Handle incoming health data pushed by HIP.
   * Looks up the correct keypair by consentId, decrypts, parses FHIR, and persists.
   */
  async receiveHealthInformation(data: any) {
    try {
      // The ABDM data push body carries `transactionId` + `entries` + `keyMaterial`
      // but NOT the consent id by default. Our HIP includes `consentId` so the HIU
      // can correlate the push to the stored decryption keypair. Accept every shape.
      const abdmConsentId =
        data.hiRequest?.consent?.id || data.consentId || data.consent?.id;
      const hipKeyMaterial = data.keyMaterial;

      logger.info('HIU: Receiving health information', {
        transactionId: data.transactionId,
        consentId: abdmConsentId,
        entries: data.entries?.length || 0,
      });
      const decryptedEntries: any[] = [];

      let keyPairRecord: { privateKey: string; nonce: string } | null = null;

      if (abdmConsentId) {
        const record = await prisma.consentKeyPair.findUnique({
          where: { consentId: abdmConsentId },
        });
        if (record) {
          keyPairRecord = {
            privateKey: decryptPrivateKey(record.privateKey),
            nonce: record.nonce,
          };
        }
      }

      for (const entry of data.entries || []) {
        if (!entry.content || !hipKeyMaterial) {
          decryptedEntries.push({ raw: entry, decrypted: false });
          continue;
        }

        if (!keyPairRecord) {
          logger.warn('HIU: No keypair found for consentId, storing raw', { abdmConsentId });
          decryptedEntries.push({ raw: entry, decrypted: false });
          continue;
        }

        try {
          const decryptedText = EncryptionService.decryptWithECDH(
            entry.content,
            keyPairRecord.privateKey,
            keyPairRecord.nonce,
            hipKeyMaterial.dhPublicKey?.keyValue,
            hipKeyMaterial.nonce,
          );
          const parsed = JSON.parse(decryptedText);
          decryptedEntries.push({ data: parsed, decrypted: true });
        } catch (decErr: any) {
          logger.error('HIU: Failed to decrypt entry', { error: decErr.message });
          decryptedEntries.push({ raw: entry, decrypted: false, error: decErr.message });
        }
      }

      // Clean up the keypair only after the last page (or if no pagination info is present)
      const pageNumber = data.pageNumber ?? data.hiRequest?.pageNumber;
      const pageCount = data.pageCount ?? data.hiRequest?.pageCount;
      const isLastPage =
        pageNumber == null || pageCount == null || pageNumber >= pageCount - 1;

      if (abdmConsentId && isLastPage) {
        await prisma.consentKeyPair.deleteMany({ where: { consentId: abdmConsentId } });
        logger.info('HIU: Keypair deleted (last page)', { abdmConsentId, pageNumber, pageCount });
      } else if (abdmConsentId) {
        logger.info('HIU: Keypair retained for next page', { abdmConsentId, pageNumber, pageCount });
      }

      // Find the patient linked to this consent and persist parsed records.
      // We tag every record with both the consent id (so the read-time gate /
      // revoke cascade can find it) and the consent's requesterHospitalId (so
      // a doctor at a different hospital can never see records pulled under
      // someone else's consent).
      if (abdmConsentId) {
        const consent = await prisma.consent.findFirst({
          where: { abdmConsentId },
          select: { patientId: true, id: true, status: true, requesterHospitalId: true, purgedAt: true },
        });

        // Refuse to persist records that arrive after revoke/expire — this
        // closes the race window where ABDM is still pushing pages while the
        // status flips. Without this, a slow push can re-create rows the
        // cascade-delete just removed.
        const isAuthorised = consent && consent.status === 'GRANTED' && !consent.purgedAt;

        if (consent && !isAuthorised) {
          logger.warn('HIU: dropping incoming health data — consent no longer authorised', {
            abdmConsentId,
            consentStatus: consent.status,
            purged: !!consent.purgedAt,
          });
        } else if (consent) {
          for (const entry of decryptedEntries) {
            if (!entry.decrypted || !entry.data) continue;

            const parsed = parseFHIRBundle(entry.data);
            await prisma.externalHealthRecord.create({
              data: {
                patientId: consent.patientId,
                consentId: abdmConsentId,
                hospitalId: consent.requesterHospitalId || null,
                sourceHipId: parsed.sourceHIP || null,
                sourceHipName: parsed.sourceHIP || null,
                recordType: parsed.compositionTitle || 'Health Record',
                recordDate: parsed.encounters[0]?.date ? new Date(parsed.encounters[0].date) : null,
                rawBundle: entry.data,
                parsedData: parsed as any,
              },
            });
          }
        }
      }

      logger.info('HIU: Health information processed', {
        transactionId: data.transactionId,
        totalEntries: data.entries?.length || 0,
        decryptedCount: decryptedEntries.filter(e => e.decrypted).length,
      });

      return { success: true, message: 'Health information received successfully', entries: decryptedEntries };
    } catch (error: any) {
      logger.error('HIU: Failed to receive health information', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Get external (ABDM-fetched) health records for a patient.
   *
   * M3 read-time gating (compliance-critical):
   *   - A clinician may only see records that were ingested under a consent
   *     that is STILL in GRANTED status.
   *   - Records under a REVOKED / EXPIRED / DENIED consent must be invisible
   *     even if the cascade-delete sweeper has not run yet.
   *   - Records with no consentId (legacy, pre-FK) are excluded for safety.
   *   - Multi-tenancy: a doctor at hospital A must not see records pulled
   *     under a consent issued by hospital B for the same patient.
   */
  async getPatientHealthRecords(patientId: string, currentUser?: any) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      if (currentUser?.role !== 'SUPER_ADMIN' && currentUser?.hospitalId && patient.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Access denied: Patient belongs to a different hospital', 403);
      }

      // Build the set of consent identifiers the requesting hospital is still
      // authorised under (active = GRANTED, not expired, not purged). Match by
      // both local consentId and the ABDM artefact consentId because rows have
      // historically used either.
      const now = new Date();
      const activeConsents = await prisma.consent.findMany({
        where: {
          patientId,
          status: 'GRANTED',
          purgedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          // Multi-tenant scope: SUPER_ADMIN sees everything; everyone else
          // only sees records pulled under their own hospital's consents.
          ...(currentUser?.role !== 'SUPER_ADMIN' && currentUser?.hospitalId
            ? { requesterHospitalId: currentUser.hospitalId }
            : {}),
        },
        select: { id: true, consentId: true, abdmConsentId: true },
      });

      if (!activeConsents.length) {
        return { success: true, data: [] };
      }

      const allowedConsentIds = new Set<string>();
      for (const c of activeConsents) {
        if (c.id) allowedConsentIds.add(c.id);
        if (c.consentId) allowedConsentIds.add(c.consentId);
        if (c.abdmConsentId) allowedConsentIds.add(c.abdmConsentId);
      }

      const externalRecords = await prisma.externalHealthRecord.findMany({
        where: {
          patientId,
          consentId: { in: Array.from(allowedConsentIds) },
        },
        orderBy: { receivedAt: 'desc' },
      });

      return { success: true, data: externalRecords };
    } catch (error: any) {
      logger.error('HIU: Failed to fetch health records', error);
      rethrowServiceError(error);
    }
  }

}

export default new HiuService();
