import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { ConsentPurpose } from '@prisma/client';
import { purgeConsentData } from '../hiu/consent-compliance';
import { rethrowServiceError } from '../../common/utils/serviceErrors';

// ─────────────────────────────────────────────────────────────────────────────
// Consent Service V3 (M3 — Consent Management)
// ─────────────────────────────────────────────────────────────────────────────

interface ConsentRequestData {
  patientAbhaId: string;
  purpose: string;
  hiTypes: string[];
  dateRangeFrom: string;
  dateRangeTo: string;
  requesterName: string;
  requesterId: string;
}

export class ConsentService {

  /**
   * M3: Create consent request
   * POST /api/hiecm/consent/v3/request/init
   */
  async createConsentRequest(data: ConsentRequestData) {
    try {
      logger.info('Creating consent request', { patientAbhaId: data.patientAbhaId });

      const patient = await prisma.patient.findFirst({
        where: {
          OR: [
            { abhaId: data.patientAbhaId },
            { abhaNumber: data.patientAbhaId },
            { abhaAddress: data.patientAbhaId },
            { abhaRecord: { abhaNumber: data.patientAbhaId } },
            { abhaRecord: { abhaAddress: data.patientAbhaId } },
          ],
        },
        include: { abhaRecord: true },
      });

      if (!patient) throw new AppError('Patient with ABHA ID not found', 404);

      // ABDM consent init requires the patient's ABHA *address* (PHR address,
      // e.g. "name@sbx") as consent.patient.id — NOT the 14-digit ABHA number.
      // Sending the number makes ABDM respond "user not found". So prefer any
      // identifier that looks like an address (contains "@"); only then fall
      // back to other identifiers.
      const candidates = [
        patient.abhaRecord?.abhaAddress,
        patient.abhaAddress,
        data.patientAbhaId,
        patient.abhaRecord?.abhaNumber,
        patient.abhaNumber,
        patient.abhaId,
      ].filter(Boolean) as string[];

      const abhaAddress = candidates.find((c) => c.includes('@'));
      if (!abhaAddress) {
        throw new AppError(
          'This patient has no ABHA address on file. ABDM consent requires the patient\'s ABHA address (e.g. name@sbx), not the ABHA number. Verify the patient\'s ABHA (ABHA Management → Verify) to capture their address, then retry.',
          400,
        );
      }
      const resolvedAbhaId = abhaAddress;

      const consentRequestId = `CR-${Date.now()}`;
      // Store the UUID we send to ABDM — their on-notify callback echoes it back as consentRequestId
      const abdmOutboundRequestId = crypto.randomUUID();

      // Maps frontend value → { ABDM code, ABDM text, Prisma enum }
      const PURPOSE_MAP: Record<string, { code: string; text: string; prisma: ConsentPurpose }> = {
        CAREMGT:  { code: 'CAREMGT',  text: 'Care Management',                        prisma: ConsentPurpose.CARE_MANAGEMENT },
        BTG:      { code: 'BTG',      text: 'Break the Glass',                         prisma: ConsentPurpose.BREAK_THE_GLASS },
        PUBHLTH:  { code: 'PUBHLTH',  text: 'Public Health',                           prisma: ConsentPurpose.PUBLIC_HEALTH },
        HPAYMT:   { code: 'HPAYMT',   text: 'Healthcare Payment',                      prisma: ConsentPurpose.HEALTHCARE_PAYMENT },
        DSRCH:    { code: 'DSRCH',    text: 'Disease Specific Healthcare Research',    prisma: ConsentPurpose.DISEASE_SPECIFIC_HEALTHCARE_RESEARCH },
        PATRQT:   { code: 'PATRQT',   text: 'Self Requested',                          prisma: ConsentPurpose.SELF_REQUESTED },
        HQUALITY: { code: 'HQUALITY', text: 'Healthcare Quality',                      prisma: ConsentPurpose.HEALTHCARE_QUALITY_AUDIT },
      };
      const purpose = PURPOSE_MAP[data.purpose] || PURPOSE_MAP['CAREMGT'];

      // ABDM V3: dateRange must be present/past — cap "to" at now if it's in the future
      const fromDt = new Date(data.dateRangeFrom).toISOString();
      const toDtRaw = new Date(data.dateRangeTo + 'T23:59:59');
      const toDt = toDtRaw > new Date() ? new Date().toISOString() : toDtRaw.toISOString();

      const requestPayload = {
        requestId: abdmOutboundRequestId,
        timestamp: new Date().toISOString(),
        consent: {
          purpose: {
            text: purpose.text,
            code: purpose.code,
            refUri: 'http://terminology.hl7.org/ValueSet/v3-PurposeOfUse',
          },
          patient: { id: resolvedAbhaId },
          hiu: { id: abdmConfig.hiu.id },
          // Per the official M3 consent/v3/request/init body, hip + careContexts
          // are explicit (null = "any facility / all linked care contexts"). The
          // CM resolves the patient's LINKED care contexts itself; sending null
          // (instead of omitting) matches the spec and avoids the CM treating the
          // request as facility-scoped with no targets.
          hip: null,
          careContexts: null,
          requester: {
            name: data.requesterName,
            identifier: { type: 'REGNO', value: data.requesterId, system: 'https://www.mciindia.org' },
          },
          hiTypes: data.hiTypes,
          permission: {
            accessMode: 'VIEW',
            dateRange: { from: fromDt, to: toDt },
            dataEraseAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            // M3 spec uses value: 0 (no per-period cap). value: 1 previously
            // limited fetches to once per hour.
            frequency: { unit: 'HOUR', value: 0, repeats: 0 },
          },
        },
      };

      // Pass our generated requestId as the REQUEST-ID header so ABDM echoes it
      // back in the on-init callback (response.requestId). That lets us correlate
      // ABDM's async-assigned consentRequest.id to this local record. Without a
      // known REQUEST-ID the abdm-client generates a random one per call and the
      // on-init callback can never be matched.
      const abdmResponse = await abdmClient.post(
        abdmConfig.endpoints.consent.init,
        requestPayload,
        { 'REQUEST-ID': abdmOutboundRequestId },
      );

      const consent = await prisma.consent.create({
        data: {
          consentId: consentRequestId,
          patientId: patient.id,
          status: 'REQUESTED',
          purpose: purpose.prisma,
          hiTypes: data.hiTypes,
          dateRange: { from: fromDt, to: toDt },
          requesterName: data.requesterName,
          requesterId: data.requesterId,
          // Store outbound requestId immediately — ABDM echoes it in the on-notify callback
          abdmRequestId: abdmOutboundRequestId,
        },
      });

      // abdmClient.post() returns response.data DIRECTLY, so the previous
      // abdmResponse.data.consentRequest.id was always undefined (double .data).
      // ABDM's consent init returns the assigned consentRequest.id — sometimes
      // synchronously, sometimes only via the on-init callback. Capture it here
      // when present so the on-notify callback (which references
      // consentRequestId == consentRequest.id) can be correlated to this record.
      const abdmSyncId = abdmResponse?.consentRequest?.id || abdmResponse?.consentRequestId;
      if (abdmSyncId && abdmSyncId !== abdmOutboundRequestId) {
        await prisma.consent.update({
          where: { id: consent.id },
          data: { abdmRequestId: abdmSyncId },
        });
      }

      logger.info('Consent request created', { consentId: consent.consentId, abdmRequestId: abdmOutboundRequestId });
      return { success: true, data: consent, message: 'Consent request created successfully' };
    } catch (error: any) {
      const abdmRaw = error?.response?.data;
      // ABDM returns errors as an array: [{"error":{"code":"...","message":"..."}}]
      const abdmError = Array.isArray(abdmRaw) ? abdmRaw[0] : abdmRaw;
      logger.error('Failed to create consent request', {
        message: error?.message,
        status: error?.response?.status,
        abdmError: JSON.stringify(abdmRaw)?.substring(0, 500),
      });
      const userMessage = abdmError?.error?.message
        || abdmError?.message
        || error.message
        || 'Failed to create consent request';
      throw new AppError(userMessage, error?.response?.status || error.statusCode || 500);
    }
  }

  /**
   * M3: Check consent request status
   * POST /api/hiecm/consent/v3/request/status
   */
  async checkConsentStatus(consentRequestId: string) {
    try {
      const res = await abdmClient.post(abdmConfig.endpoints.hiu.consentStatus, {
        consentRequestId,
      });
      return { success: true, data: res };
    } catch (error: any) {
      logger.error('Failed to check consent status', error);
      rethrowServiceError(error);
    }
  }

  /**
   * HIP-side consent notification from ABDM (CM → HIP).
   * ABDM calls: POST /api/v3/consent/request/hip/notify
   *
   * Per the official M2 collection the body is NESTED and carries the granted
   * artefact directly (NOT a consentRequestId):
   *   { notification: { status, consentId, consentDetail: { consentId, patient:{id},
   *     careContexts:[], hip:{id}, hiTypes:[], permission:{} }, signature } }
   *
   * The HIP must (a) record the granted consent artefact so a later
   * health-information request can be validated, and (b) acknowledge receipt to
   * ABDM at /consent/v3/request/hip/on-notify with status "ok".
   */
  async handleConsentNotification(payload: any, requestId?: string) {
    const statusMap: Record<string, string> = {
      GRANTED: 'GRANTED',
      DENIED: 'DENIED',
      EXPIRED: 'EXPIRED',
      REVOKED: 'REVOKED',
    };
    let abdmConsentId: string | undefined;
    let echoedRequestId: string | undefined;
    try {
      const notification = payload?.notification || {};
      const consentDetail = notification.consentDetail || {};
      abdmConsentId = notification.consentId || consentDetail.consentId;
      // The REQUEST-ID arrives as an HTTP header (passed in as `requestId`); the
      // body rarely carries it. Prefer the header, fall back to any body field.
      echoedRequestId = requestId || payload?.requestId || payload?.response?.requestId;
      const status = statusMap[notification.status] || notification.status || 'GRANTED';

      logger.info('HIP: consent notification received', { abdmConsentId, status });

      if (abdmConsentId) {
        // The HIP-side notification exists so the HIP can RECORD the granted
        // artefact (dateRange/hiTypes/careContexts) for validating future
        // health-information requests. Status authority for a HIU-created
        // consent belongs to the HIU on-notify callback — so we match precisely
        // and only ever PROMOTE a still-REQUESTED consent. We never re-flip an
        // already GRANTED/DENIED/REVOKED record (that caused the wrong consent
        // to change when a patient had multiple requests).
        let consent = await prisma.consent.findFirst({ where: { abdmConsentId } });
        if (!consent) {
          const patientAddr: string | undefined = consentDetail?.patient?.id;
          if (patientAddr) {
            const patient = await prisma.patient.findFirst({
              where: { OR: [{ abhaAddress: patientAddr }, { abhaRecord: { abhaAddress: patientAddr } }] },
              select: { id: true },
            });
            if (patient) {
              consent = await prisma.consent.findFirst({
                // Only a REQUESTED consent (no artefact yet) is a safe match here.
                where: { patientId: patient.id, abdmConsentId: null, status: 'REQUESTED' as any },
                orderBy: { createdAt: 'desc' },
              });
            }
          }
        }

        if (consent) {
          // Persist the granted artefact window/types so the data-flow request
          // validates/clamps against what was ACTUALLY granted (not the original
          // request). Only set status when promoting a still-REQUESTED consent.
          const artefactDateRange = consentDetail?.permission?.dateRange;
          const artefactHiTypes: string[] | undefined = consentDetail?.hiTypes;
          const promote = consent.status === 'REQUESTED';
          await prisma.consent.update({
            where: { id: consent.id },
            data: {
              abdmConsentId,
              ...(artefactDateRange ? { dateRange: artefactDateRange } : {}),
              ...(artefactHiTypes?.length ? { hiTypes: artefactHiTypes } : {}),
              ...(promote ? { status: status as any } : {}),
              ...(promote && status === 'GRANTED' ? { grantedAt: new Date() } : {}),
              ...(status === 'REVOKED' ? { status: 'REVOKED' as any, revokedAt: new Date() } : {}),
            },
          });
          logger.info('HIP: consent artefact recorded', { consentId: consent.consentId, status, promoted: promote });
        } else {
          logger.warn('HIP: no local consent matched notification', { abdmConsentId });
        }
      } else {
        logger.warn('HIP: consent notification missing consentId', { keys: Object.keys(payload || {}) });
      }
    } catch (error: any) {
      // Never throw — ABDM only needs a receipt acknowledgement.
      logger.error('Failed to process HIP consent notification', { message: error?.message });
    }

    // Acknowledge receipt to ABDM (literal status "ok" per M2 spec).
    try {
      await abdmClient.post(
        abdmConfig.endpoints.hip.consentOnNotify,
        {
          acknowledgement: { status: 'ok', consentId: abdmConsentId },
          response: { requestId: echoedRequestId },
        },
        { 'X-HIP-ID': abdmConfig.hip.id },
      );
    } catch (e: any) {
      logger.warn('HIP: consent on-notify ack failed', { message: e?.message });
    }

    return { success: true, message: 'Consent notification processed' };
  }

  /**
   * Return the consent artefact + associated external records for display.
   *
   * ABDM's /consent/v3/fetch is asynchronous — it returns only an ACK, and the
   * actual artefact body lands later on /api/v3/hiu/consents/on-fetch and is
   * persisted in `Consent.artefactBody`. So this endpoint:
   *   1. Reads the locally-stored artefact (the source of truth at read-time)
   *   2. Optionally triggers a fresh ABDM fetch if no body has been received
   *      yet AND the consent is GRANTED — fire-and-forget; UI re-polls.
   *   3. Returns: { consent, artefact, records[], recordsCount, purged }
   *
   * Compliance: when `purgedAt` is set (revoked / expired), no record bodies
   * are returned — the row is just a metadata stub showing the lifecycle ended.
   */
  async fetchConsentArtefact(consentId: string, currentUser?: { role?: string; hospitalId?: string }) {
    try {
      const consent = await prisma.consent.findUnique({
        where: { id: consentId },
        include: { patient: { include: { abhaRecord: true } } },
      });

      if (!consent) throw new AppError('Consent not found', 404);
      if (
        currentUser &&
        currentUser.role !== 'SUPER_ADMIN' &&
        consent.patient?.hospitalId &&
        consent.patient.hospitalId !== currentUser.hospitalId
      ) {
        throw new AppError('Consent not found', 404);
      }

      // Trigger a fresh ABDM artefact fetch only if we don't yet have a body
      // and the consent is in a state where ABDM will respond. Fire-and-forget;
      // the on-fetch callback persists the body and the UI can re-load.
      if (
        consent.status === 'GRANTED' &&
        !!consent.abdmConsentId &&
        !consent.artefactBody
      ) {
        abdmClient
          .post(
            abdmConfig.endpoints.consent.fetch,
            { consentId: consent.abdmConsentId },
            { 'X-HIU-ID': abdmConfig.hiu.id },
          )
          .then(() => logger.info('Consent artefact fetch (re)requested', { consentId: consent.consentId }))
          .catch((err: any) => logger.warn('Consent artefact fetch failed', { message: err?.message }));
      }

      // Pull external records linked under this consent. We block bodies once
      // the consent has been purged (revoke/expire), even before the cascade
      // fully completes — the read-time gate in HIU service uses the same rule.
      const allKeys = [consent.id, consent.consentId, consent.abdmConsentId].filter(Boolean) as string[];
      let records: any[] = [];
      let recordsCount = 0;
      if (allKeys.length && !consent.purgedAt) {
        const found = await prisma.externalHealthRecord.findMany({
          where: { consentId: { in: allKeys } },
          orderBy: { receivedAt: 'desc' },
          select: {
            id: true,
            sourceHipName: true,
            sourceHipId: true,
            recordType: true,
            recordDate: true,
            receivedAt: true,
            parsedData: true,
          },
        });
        records = found;
        recordsCount = found.length;
      } else if (allKeys.length && consent.purgedAt) {
        // We still want to know if there were any records (now purged) so the
        // UI can show "Purged on …" with the correct prior count. Cheap count.
        recordsCount = await prisma.externalHealthRecord.count({
          where: { consentId: { in: allKeys } },
        });
      }

      return {
        success: true,
        data: {
          consentId: consent.consentId,
          abdmConsentId: consent.abdmConsentId,
          status: consent.status,
          purgedAt: consent.purgedAt,
          artefact: consent.artefactBody || null,
          artefactFetchedAt: consent.artefactFetchedAt,
          records,
          recordsCount,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch consent artefact', error);
      rethrowServiceError(error);
    }
  }

  async getPatientConsents(patientId: string, currentUser?: { role?: string; hospitalId?: string }) {
    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { hospitalId: true },
      });
      if (!patient || patient.hospitalId !== currentUser.hospitalId) {
        return { success: true, data: [] };
      }
    }
    const consents = await prisma.consent.findMany({ where: { patientId }, orderBy: { createdAt: 'desc' } });
    return { success: true, data: consents };
  }

  async revokeConsent(consentId: string, currentUser?: { role?: string; hospitalId?: string }) {
    try {
      const consent = await prisma.consent.findUnique({
        where: { id: consentId },
        include: { patient: { select: { hospitalId: true } } },
      });
      if (!consent) throw new AppError('Consent not found', 404);
      if (
        currentUser &&
        currentUser.role !== 'SUPER_ADMIN' &&
        consent.patient?.hospitalId &&
        consent.patient.hospitalId !== currentUser.hospitalId
      ) {
        throw new AppError('Consent not found', 404);
      }

      // ABDM provides NO HIU-initiated consent-revoke endpoint (the M3 HIU API
      // set is: init, status, on-notify, fetch, health-info-request, data-flow
      // notify). Consent revocation is a PATIENT action in the ABHA/PHR app; the
      // HIU is informed asynchronously via the hiu on-notify callback (status
      // REVOKED). So "Cancel"/"Revoke" from our side is purely a LOCAL state
      // change — we stop requesting/using the consent. The old hard requirement
      // for `abdmConsentId` made this button always fail for still-REQUESTED
      // consents (which have no artefact id yet).
      if (consent.status === 'REVOKED') {
        return { success: true, message: 'Consent already cancelled' };
      }

      await prisma.consent.update({
        where: { id: consentId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });

      // M3 compliance: a local revoke / cancel must wipe any cached health
      // records and the decryption keypair under this consent. If the consent
      // had never reached GRANTED there is nothing to wipe — the helper is a
      // no-op in that case.
      const purge = await purgeConsentData(consent.id);

      logger.info('Consent cancelled/revoked locally', {
        consentId: consent.consentId,
        previousStatus: consent.status,
        hadAbdmConsentId: !!consent.abdmConsentId,
        recordsDeleted: purge.externalRecordsDeleted,
        keyPairsDeleted: purge.keyPairsDeleted,
      });
      return {
        success: true,
        message: consent.abdmConsentId
          ? `Consent cancelled locally. ${purge.externalRecordsDeleted} record(s) purged. ABDM revocation of a granted consent is patient-driven via the ABHA app — the HIU has stopped using this consent.`
          : 'Consent request cancelled.',
      };
    } catch (error: any) {
      logger.error('Failed to revoke consent', error);
      rethrowServiceError(error);
    }
  }

  async getAllConsents(currentUser?: any) {
    const where: any = {};
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
      where.patient = { hospitalId: currentUser.hospitalId };
    }
    const consents = await prisma.consent.findMany({
      where,
      include: { patient: { select: { id: true, firstName: true, lastName: true, abhaRecord: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Annotate each consent with the count of stored external health records.
    // This lets the UI show "X records pulled" right on the row, and renders a
    // clear empty state ("No records pulled yet") on the details dialog so an
    // operator can tell at a glance whether they still need to click Fetch.
    const ids: string[] = [];
    for (const c of consents) {
      if (c.id) ids.push(c.id);
      if (c.consentId && c.consentId !== c.id) ids.push(c.consentId);
      if (c.abdmConsentId) ids.push(c.abdmConsentId);
    }

    let countsByKey: Record<string, number> = {};
    if (ids.length) {
      const grouped = await prisma.externalHealthRecord.groupBy({
        by: ['consentId'],
        where: { consentId: { in: ids } },
        _count: { _all: true },
      });
      for (const g of grouped) {
        if (g.consentId) countsByKey[g.consentId] = g._count._all;
      }
    }

    const annotated = consents.map((c) => {
      const recordsCount =
        (countsByKey[c.id] || 0) +
        (countsByKey[c.consentId] || 0) +
        (c.abdmConsentId ? (countsByKey[c.abdmConsentId] || 0) : 0);
      return { ...c, recordsCount };
    });

    return { success: true, data: annotated };
  }

  async getConsentStatusById(consentId: string, currentUser?: { role?: string; hospitalId?: string }) {
    const consent = await prisma.consent.findUnique({
      where: { id: consentId },
      select: {
        id: true, consentId: true, status: true, grantedAt: true, revokedAt: true,
        createdAt: true, updatedAt: true,
        patient: { select: { hospitalId: true } },
      },
    });
    if (!consent) throw new AppError('Consent not found', 404);
    if (
      currentUser &&
      currentUser.role !== 'SUPER_ADMIN' &&
      consent.patient?.hospitalId &&
      consent.patient.hospitalId !== currentUser.hospitalId
    ) {
      throw new AppError('Consent not found', 404);
    }
    const { patient, ...rest } = consent as any;
    return { success: true, data: rest };
  }

  async getConsentStats(currentUser?: any) {
    const where: any = {};
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
      where.patient = { hospitalId: currentUser.hospitalId };
    }
    const [total, granted, denied, pending, revoked, expired] = await Promise.all([
      prisma.consent.count({ where }),
      prisma.consent.count({ where: { ...where, status: 'GRANTED' } }),
      prisma.consent.count({ where: { ...where, status: 'DENIED' } }),
      prisma.consent.count({ where: { ...where, status: 'REQUESTED' } }),
      prisma.consent.count({ where: { ...where, status: 'REVOKED' } }),
      prisma.consent.count({ where: { ...where, status: 'EXPIRED' } }),
    ]);
    return { success: true, data: { total, granted, denied, pending, revoked, expired } };
  }
}

export default new ConsentService();
