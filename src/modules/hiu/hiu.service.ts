import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient, { resolveHiuTenant } from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';
import { config } from '../../common/config/index';
import { parseFHIRBundle } from '../../common/utils/fhir/fhir-parser';
import { rethrowServiceError } from '../../common/utils/serviceErrors';
import { getEffectiveHospitalId } from '../../common/utils/scope';

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
  async requestHealthInformation(
    data: {
      consentId: string;
      // dateRange is OPTIONAL — defaults to the consent artefact's granted
      // window (consent.dateRange) when not supplied, so the UI can fire a
      // one-click pull without making the user re-pick dates that were
      // already picked when consent was requested.
      dateRangeFrom?: string;
      dateRangeTo?: string;
      dataPushUrl?: string;
    },
    currentUser?: any,
  ) {
    try {
      logger.info('HIU: Requesting health information', { consentId: data.consentId });

      const consent = await prisma.consent.findUnique({
        where: { id: data.consentId },
        include: { patient: { include: { abhaRecord: true } } },
      });

      if (!consent) throw new AppError('Consent not found', 404);

      // Fall back to the consent's granted dateRange when the caller didn't
      // pass explicit dates. This is the common case (auto-pull on grant /
      // single-click pull from the UI). Spec: dateRange is part of
      // permission so we'd be requesting outside the granted window if we
      // sent something else — using the consent's window is always safe.
      const consentRange = (consent.dateRange as { from?: string; to?: string } | null) || null;
      const dateRangeFrom = data.dateRangeFrom || consentRange?.from;
      const dateRangeTo = data.dateRangeTo || consentRange?.to;
      if (!dateRangeFrom || !dateRangeTo) {
        throw new AppError(
          'No dateRange available — the consent has no granted dateRange yet (artefact body has not been fetched). Try again in a few seconds, or pass dateRange explicitly.',
          400,
        );
      }

      // Multi-tenant guard: only the requesting hospital (or SUPER_ADMIN)
      // may pull data against this consent. The consent's
      // `requesterHospitalId` is set when the consent is created and is the
      // single source of truth for "who owns this consent". Without this
      // check, any HIU user with a consent UUID could trigger record
      // fetches for another hospital's patient.
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        if (
          consent.requesterHospitalId &&
          consent.requesterHospitalId !== currentUser.hospitalId
        ) {
          throw new AppError('Consent not found', 404);
        }
        // Fallback: if the consent has no requesterHospitalId (legacy data)
        // require the patient itself to be in the caller's hospital.
        if (
          !consent.requesterHospitalId &&
          consent.patient?.hospitalId &&
          consent.patient.hospitalId !== currentUser.hospitalId
        ) {
          throw new AppError('Consent not found', 404);
        }
      }

      if (consent.status !== 'GRANTED') throw new AppError('Consent not granted', 403);
      if (!consent.abdmConsentId) throw new AppError('ABDM consent ID not available', 400);

      // Resolve the requesting tenant's HIU identity. Prefer the consent's
      // requesterHospitalId (the source of truth for "who owns this consent");
      // fall back to the current user's hospital. Throws if no hiuId — we
      // refuse to silently issue a /cm/request under the platform default
      // hiuId because the matching /on-request callback would then route to
      // the wrong tenant on a multi-facility deployment.
      const tenantHospitalId =
        consent.requesterHospitalId
        || (currentUser?.hospitalId as string | undefined);
      if (!tenantHospitalId) {
        throw new AppError(
          'Cannot resolve a hospital tenant for this consent — set consent.requesterHospitalId or pass a currentUser with hospitalId.',
          422,
        );
      }
      const tenant = await resolveHiuTenant(tenantHospitalId);

      const ecdhKeyPair = EncryptionService.generateECDHKeyPair();

      // Generate our own REQUEST-ID for the cm/request and persist it alongside
      // the keypair. ABDM gateway echoes this id back in the /on-request
      // callback (via response.requestId) and ALSO assigns a transactionId
      // there which is the only id later present on the data/notification
      // push. We use this 3-way mapping (consentId / requestId / transactionId)
      // to look up the right private key when the encrypted data arrives.
      const cmRequestId = crypto.randomUUID();

      await prisma.consentKeyPair.upsert({
        where: { consentId: consent.abdmConsentId },
        update: {
          privateKey: encryptPrivateKey(ecdhKeyPair.privateKey),
          nonce: ecdhKeyPair.nonce,
          requestId: cmRequestId,
          // Reset transactionId so a re-issued request doesn't keep a stale
          // mapping from a previous attempt.
          transactionId: null,
        },
        create: {
          consentId: consent.abdmConsentId,
          privateKey: encryptPrivateKey(ecdhKeyPair.privateKey),
          nonce: ecdhKeyPair.nonce,
          requestId: cmRequestId,
        },
      });

      const requestPayload = {
        hiRequest: {
          consent: { id: consent.abdmConsentId },
          dateRange: { from: dateRangeFrom, to: dateRangeTo },
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

      // Override REQUEST-ID with the one we just stored — gatewayHeaders
      // would otherwise stamp a fresh random uuid we'd be unable to track.
      await abdmClient.post(
        abdmConfig.endpoints.hiu.healthInfoRequest,
        requestPayload,
        { 'REQUEST-ID': cmRequestId, 'X-HIU-ID': tenant.hiuId },
        tenant,
      );

      logger.info('HIU: Health information request sent', {
        consentId: consent.consentId,
        cmRequestId,
        hiuId: tenant.hiuId,
        hospitalId: tenant.hospitalId,
      });
      return { success: true, message: 'Health information request sent successfully' };
    } catch (error: any) {
      logger.error('HIU: Failed to request health information', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Handle the gateway's `/health-information/on-request` callback.
   *
   * ABDM dispatches this asynchronously after our `/cm/request` is processed:
   *   {
   *     "requestId": "<gateway-uuid>",
   *     "timestamp": "...",
   *     "hiRequest": {
   *       "transactionId": "<gateway-issued>",
   *       "sessionStatus": "REQUESTED" | "ACKNOWLEDGED" | ...
   *     },
   *     "error": {...} | null,
   *     "response": { "requestId": "<our-original-REQUEST-ID>" }
   *   }
   *
   * Job here:
   *   1) Find the ConsentKeyPair whose requestId equals response.requestId.
   *   2) Persist hiRequest.transactionId on it — the data/notification push
   *      that follows carries ONLY this transactionId, not the consent id, so
   *      this mapping is what lets us pick the right private key.
   *
   * Returns nothing; the route layer ACKs the gateway with 202.
   */
  async handleHealthInformationOnRequest(body: any) {
    try {
      const ourRequestId: string | undefined =
        body?.response?.requestId || body?.resp?.requestId;
      const transactionId: string | undefined =
        body?.hiRequest?.transactionId || body?.transactionId;
      const sessionStatus: string | undefined =
        body?.hiRequest?.sessionStatus || body?.sessionStatus;

      logger.info('HIU: health-information on-request received', {
        ourRequestId,
        transactionId,
        sessionStatus,
        hasError: !!body?.error,
      });

      if (body?.error) {
        // Gateway rejected our cm/request. Drop the keypair so we don't hold
        // dead state, but don't throw — the caller is the gateway and we
        // already returned 202 from the route layer.
        if (ourRequestId) {
          await prisma.consentKeyPair
            .updateMany({ where: { requestId: ourRequestId }, data: { transactionId: null } })
            .catch(() => undefined);
        }
        logger.warn('HIU: gateway returned error on cm/request', {
          ourRequestId,
          error: body.error,
        });
        return;
      }

      if (!ourRequestId || !transactionId) {
        logger.warn('HIU: on-request missing requestId/transactionId — cannot map', {
          ourRequestId,
          transactionId,
        });
        return;
      }

      // Stamp the transactionId on the matching keypair. updateMany skips
      // gracefully if the row was already deleted (e.g. data already arrived
      // and we cleaned up the keypair).
      const updated = await prisma.consentKeyPair.updateMany({
        where: { requestId: ourRequestId },
        data: { transactionId },
      });

      if (updated.count === 0) {
        logger.warn('HIU: on-request — no keypair matched our REQUEST-ID', {
          ourRequestId,
          transactionId,
        });
      } else {
        logger.info('HIU: on-request mapped transactionId → keypair', {
          ourRequestId,
          transactionId,
        });
      }
    } catch (error: any) {
      // Never throw from a callback handler — gateway has already moved on.
      logger.error('HIU: handleHealthInformationOnRequest failed', error);
    }
  }

  /**
   * Handle consent notification for HIU
   * POST /api/hiecm/consent/v3/request/hiu/on-notify
   */
  async consentOnNotify(
    params: { requestId: string; consentIds: Array<{ status: string; consentId: string }> },
    tenantHospitalId?: string,
  ) {
    try {
      // Optional tenant: in the legacy single-tenant path the caller doesn't
      // know which hospital owns the consent (the body only has consentIds).
      // When provided, route the ack under the tenant's hiuId; otherwise
      // fall back to the platform hiuId (best-effort backwards compat).
      const tenant = tenantHospitalId ? await resolveHiuTenant(tenantHospitalId) : null;
      const headers: Record<string, string> | undefined = tenant
        ? { 'X-HIU-ID': tenant.hiuId }
        : undefined;
      await abdmClient.post(
        abdmConfig.endpoints.hiu.consentOnNotify,
        {
          acknowledgement: params.consentIds.map(c => ({ status: c.status, consentId: c.consentId })),
          response: { requestId: params.requestId },
        },
        headers,
        tenant,
      );
      logger.info('HIU: consent on-notify acknowledged', { hiuId: tenant?.hiuId });
    } catch (error: any) {
      logger.error('HIU: consent on-notify failed', error);
      rethrowServiceError(error);
    }
  }

  /**
   * Send data flow completion notification
   * POST /api/hiecm/data-flow/v3/health-information/notify
   */
  async dataFlowNotify(
    params: {
      consentId: string;
      transactionId: string;
      status: string;
      hipId?: string;
      statusResponses?: Array<{ careContextReference: string; hiStatus: string; description?: string }>;
    },
    tenantHospitalId?: string,
  ) {
    try {
      // Per ABDM M3 data-flow notify spec, statusNotification.hipId is REQUIRED
      // (the HIP that provided the data) and statusResponses carries per-care-
      // context delivery status. The notifier.id (NOT the same hipId) is the
      // hiuId of the hospital that received the data — must be the same hiuId
      // we used on /cm/request, otherwise ABDM rejects the notify.
      const tenant = tenantHospitalId ? await resolveHiuTenant(tenantHospitalId) : null;
      const headers: Record<string, string> | undefined = tenant
        ? { 'X-HIU-ID': tenant.hiuId }
        : undefined;
      const hipId = params.hipId || abdmConfig.hip.id;
      const notifierHiuId = tenant?.hiuId || abdmConfig.hiu.id;
      await abdmClient.post(
        abdmConfig.endpoints.hiu.dataFlowNotify,
        {
          notification: {
            consentId: params.consentId,
            transactionId: params.transactionId,
            doneAt: new Date().toISOString(),
            notifier: { type: 'HIU', id: notifierHiuId },
            statusNotification: {
              sessionStatus: params.status,
              hipId,
              statusResponses: params.statusResponses || [],
            },
          },
        },
        headers,
        tenant,
      );
      logger.info('HIU: data flow notify sent', {
        transactionId: params.transactionId, hipId, hiuId: notifierHiuId,
      });
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
      // and NOT a consent id (per the OpenAPI spec — including unknown fields
      // breaks HIUs that run strict schema validation).
      //
      // Lookup priority for the matching ConsentKeyPair:
      //   1. transactionId (always present on the data push, mapped by our
      //      health-information/on-request handler when ABDM responded to /cm/request)
      //   2. consent id, only if a non-spec extension HIP echoed it
      //
      // (1) is the canonical, spec-compliant path; (2) only matters for
      // legacy / tightly-coupled deployments where HIP and HIU share state.
      const transactionId: string | undefined = data.transactionId;
      const abdmConsentId =
        data.hiRequest?.consent?.id || data.consentId || data.consent?.id;
      const hipKeyMaterial = data.keyMaterial;

      logger.info('HIU: Receiving health information', {
        transactionId,
        consentId: abdmConsentId,
        entries: data.entries?.length || 0,
      });
      const decryptedEntries: any[] = [];

      let keyPairRecord: { privateKey: string; nonce: string } | null = null;
      let resolvedConsentId: string | null = abdmConsentId || null;

      // Try transactionId first — the spec-compliant correlation key.
      if (transactionId) {
        const record = await prisma.consentKeyPair.findUnique({
          where: { transactionId },
        });
        if (record) {
          keyPairRecord = {
            privateKey: decryptPrivateKey(record.privateKey),
            nonce: record.nonce,
          };
          resolvedConsentId = record.consentId;
          logger.info('HIU: keypair resolved by transactionId', {
            transactionId,
            consentId: record.consentId,
          });
        }
      }

      // Fall back to consent id if some HIP did include it (or for retried
      // pushes after we've already dropped the transactionId-keyed row).
      if (!keyPairRecord && abdmConsentId) {
        const record = await prisma.consentKeyPair.findUnique({
          where: { consentId: abdmConsentId },
        });
        if (record) {
          keyPairRecord = {
            privateKey: decryptPrivateKey(record.privateKey),
            nonce: record.nonce,
          };
          resolvedConsentId = record.consentId;
          logger.info('HIU: keypair resolved by consentId fallback', {
            consentId: abdmConsentId,
            transactionId,
          });
        }
      }

      for (const entry of data.entries || []) {
        if (!entry.content || !hipKeyMaterial) {
          decryptedEntries.push({ raw: entry, decrypted: false });
          continue;
        }

        if (!keyPairRecord) {
          logger.warn('HIU: No keypair found, storing raw', {
            transactionId,
            consentId: abdmConsentId,
          });
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

      // Cleanup uses whichever id we successfully resolved. We prefer the
      // resolvedConsentId (== ConsentKeyPair.consentId from the DB row),
      // falling back to the transactionId in case a HIP pushed without one.
      const cleanupWhere = resolvedConsentId
        ? { consentId: resolvedConsentId }
        : transactionId
          ? { transactionId }
          : null;
      if (cleanupWhere && isLastPage) {
        await prisma.consentKeyPair.deleteMany({ where: cleanupWhere });
        logger.info('HIU: Keypair deleted (last page)', {
          ...cleanupWhere, pageNumber, pageCount,
        });
      } else if (cleanupWhere) {
        logger.info('HIU: Keypair retained for next page', {
          ...cleanupWhere, pageNumber, pageCount,
        });
      }

      // Find the patient linked to this consent and persist parsed records.
      // We tag every record with both the consent id (so the read-time gate /
      // revoke cascade can find it) and the consent's requesterHospitalId (so
      // a doctor at a different hospital can never see records pulled under
      // someone else's consent).
      let persistedCount = 0;
      let consentRequesterHospitalId: string | null = null;
      const careContextRefs = new Set<string>();
      let authorisationDropped = false;
      // Use whatever consent id we resolved (from keypair lookup OR the
      // optional consent id in the body) to find the parent Consent row.
      const lookupConsentId = resolvedConsentId || abdmConsentId || null;
      if (lookupConsentId) {
        const consent = await prisma.consent.findFirst({
          where: { abdmConsentId: lookupConsentId },
          select: { patientId: true, id: true, status: true, requesterHospitalId: true, purgedAt: true },
        });

        // Refuse to persist records that arrive after revoke/expire — this
        // closes the race window where ABDM is still pushing pages while the
        // status flips. Without this, a slow push can re-create rows the
        // cascade-delete just removed.
        const isAuthorised = consent && consent.status === 'GRANTED' && !consent.purgedAt;

        if (consent && !isAuthorised) {
          authorisationDropped = true;
          logger.warn('HIU: dropping incoming health data — consent no longer authorised', {
            abdmConsentId: lookupConsentId,
            consentStatus: consent.status,
            purged: !!consent.purgedAt,
          });
        } else if (consent) {
          consentRequesterHospitalId = consent.requesterHospitalId || null;
          for (const entry of decryptedEntries) {
            if (!entry.decrypted || !entry.data) continue;

            const parsed = parseFHIRBundle(entry.data);
            await prisma.externalHealthRecord.create({
              data: {
                patientId: consent.patientId,
                consentId: lookupConsentId!,
                hospitalId: consent.requesterHospitalId || null,
                sourceHipId: parsed.sourceHIP || null,
                sourceHipName: parsed.sourceHIP || null,
                recordType: parsed.compositionTitle || 'Health Record',
                recordDate: parsed.encounters[0]?.date ? new Date(parsed.encounters[0].date) : null,
                rawBundle: entry.data,
                parsedData: parsed as any,
              },
            });
            persistedCount++;
            const ccRef = entry?.raw?.careContextReference || entry?.data?.careContextReference;
            if (ccRef) careContextRefs.add(String(ccRef));
          }
        }
      }

      logger.info('HIU: Health information processed', {
        transactionId: data.transactionId,
        totalEntries: data.entries?.length || 0,
        decryptedCount: decryptedEntries.filter(e => e.decrypted).length,
        persistedCount,
      });

      // ── M3 compliance: notify CM that data was received ──────────────────
      // Per the data-flow spec, after the HIU receives encrypted bundles it
      // MUST POST /api/hiecm/data-flow/v3/health-information/notify with the
      // session status (TRANSFERRED / FAILED) plus per-care-context hiStatus
      // (OK / ERRORED). Without this the CM thinks delivery failed and
      // surfaces a stuck "in progress" to the patient. We compute status from
      // what actually decrypted+persisted; a partial decrypt counts as FAILED
      // so the patient sees something went wrong. Fire-and-forget so a
      // notify failure doesn't bubble back into the data-push retry loop.
      if (lookupConsentId && data.transactionId && !authorisationDropped) {
        const totalEntries = (data.entries || []).length;
        const allOk = totalEntries > 0 && persistedCount === totalEntries;
        const sessionStatus = allOk ? 'TRANSFERRED' : 'FAILED';
        const statusResponses = Array.from(careContextRefs).map(ref => ({
          careContextReference: ref,
          hiStatus: allOk ? 'OK' : 'ERRORED',
          ...(allOk ? {} : { description: 'Decryption or parsing failed for one or more entries' }),
        }));
        // Route the notify under the consent's requester tenant so the CM
        // sees the same hiuId we used on /cm/request. consentRequesterHospitalId
        // is captured above; if it's null (legacy data) we fall back to
        // platform default.
        const notifyTenantHospitalId = consentRequesterHospitalId || undefined;
        setImmediate(async () => {
          try {
            await this.dataFlowNotify(
              {
                consentId: lookupConsentId,
                transactionId: data.transactionId,
                status: sessionStatus,
                statusResponses,
              },
              notifyTenantHospitalId,
            );
          } catch (notifyErr: any) {
            logger.warn('HIU: data-flow notify dispatch failed', { message: notifyErr?.message });
          }
        });
      }

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

      if (currentUser?.role !== 'SUPER_ADMIN') {
        if (!currentUser?.hospitalId) {
          throw new AppError('Your account is not linked to a hospital', 403);
        }
        if (patient.hospitalId !== currentUser.hospitalId) {
          throw new AppError('Access denied: Patient belongs to a different hospital', 403);
        }
      }

      // Build the set of consent identifiers the requesting hospital is still
      // authorised under (active = GRANTED, not expired, not purged). Match by
      // both local consentId and the ABDM artefact consentId because rows have
      // historically used either.
      const now = new Date();
      // Multi-tenant scope: non-SUPER_ADMIN sees only records pulled under
      // their own hospital's consents. SUPER_ADMIN with the global "viewing
      // as" scope sees only that hospital's consents; unscoped SUPER_ADMIN
      // sees everything.
      const requesterHospitalId = getEffectiveHospitalId(currentUser);
      const activeConsents = await prisma.consent.findMany({
        where: {
          patientId,
          status: 'GRANTED',
          purgedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          ...(requesterHospitalId ? { requesterHospitalId } : {}),
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

      // Defense-in-depth: scope BOTH by allowed consents AND by the record's
      // own `hospitalId`. The consent-scope already guarantees tenant
      // isolation (records were persisted under our hospital's consent), but
      // the redundant filter ensures that even if a stale row's consentId
      // somehow falls into the allowed set the row will still be hidden
      // from a different tenant. Records with hospitalId=null (legacy data
      // ingested before this column existed) are visible only to
      // SUPER_ADMIN, never to a hospital user.
      const externalRecords = await prisma.externalHealthRecord.findMany({
        where: {
          patientId,
          consentId: { in: Array.from(allowedConsentIds) },
          ...(requesterHospitalId
            ? { hospitalId: requesterHospitalId }
            : {}),
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
