import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { ConsentPurpose } from '@prisma/client';

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
        CAREMGT: { code: 'CAREMGT', text: 'Care Management',                        prisma: ConsentPurpose.CARE_MANAGEMENT },
        BTG:     { code: 'BTG',     text: 'Break the Glass',                         prisma: ConsentPurpose.BREAK_THE_GLASS },
        PUBHLTH: { code: 'PUBHLTH', text: 'Public Health',                           prisma: ConsentPurpose.PUBLIC_HEALTH },
        HPAYMT:  { code: 'HPAYMT',  text: 'Healthcare Payment',                      prisma: ConsentPurpose.CARE_MANAGEMENT },
        DSRCH:   { code: 'DSRCH',   text: 'Disease Specific Healthcare Research',    prisma: ConsentPurpose.DISEASE_SPECIFIC_HEALTHCARE_RESEARCH },
        PATRQT:  { code: 'PATRQT',  text: 'Self Requested',                          prisma: ConsentPurpose.CARE_MANAGEMENT },
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
      throw new AppError(error.message || 'Failed to check consent status', error.statusCode || 500);
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
  async handleConsentNotification(payload: any) {
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
      echoedRequestId = payload?.requestId || payload?.response?.requestId;
      const status = statusMap[notification.status] || notification.status || 'GRANTED';

      logger.info('HIP: consent notification received', { abdmConsentId, status });

      if (abdmConsentId) {
        // Find a local consent for this artefact, or fall back to the patient's
        // most recent active consent (HIP-initiated / patient self-linking flows
        // have no abdmConsentId on file yet).
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
                where: { patientId: patient.id, status: { in: ['REQUESTED', 'GRANTED'] } as any },
                orderBy: { createdAt: 'desc' },
              });
            }
          }
        }

        if (consent) {
          await prisma.consent.update({
            where: { id: consent.id },
            data: {
              status: status as any,
              abdmConsentId,
              ...(status === 'GRANTED' ? { grantedAt: new Date() } : {}),
              ...(status === 'REVOKED' ? { revokedAt: new Date() } : {}),
            },
          });
          logger.info('HIP: consent notification applied', { consentId: consent.consentId, status });
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
   * M3: Fetch consent artefact
   * POST /api/hiecm/consent/v3/fetch
   */
  async fetchConsentArtefact(consentId: string) {
    try {
      const consent = await prisma.consent.findUnique({
        where: { id: consentId },
        include: { patient: { include: { abhaRecord: true } } },
      });

      if (!consent) throw new AppError('Consent not found', 404);
      if (!consent.abdmConsentId) throw new AppError('ABDM consent ID not available', 400);

      const response = await abdmClient.post(abdmConfig.endpoints.consent.fetch, {
        consentId: consent.abdmConsentId,
      });

      logger.info('Consent artefact fetched', { consentId: consent.consentId });
      return { success: true, data: response };
    } catch (error: any) {
      logger.error('Failed to fetch consent artefact', error);
      throw new AppError(error.message || 'Failed to fetch consent artefact', error.statusCode || 500);
    }
  }

  async getPatientConsents(patientId: string) {
    const consents = await prisma.consent.findMany({ where: { patientId }, orderBy: { createdAt: 'desc' } });
    return { success: true, data: consents };
  }

  async revokeConsent(consentId: string) {
    try {
      const consent = await prisma.consent.findUnique({ where: { id: consentId } });
      if (!consent) throw new AppError('Consent not found', 404);

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
      logger.info('Consent cancelled/revoked locally', {
        consentId: consent.consentId,
        previousStatus: consent.status,
        hadAbdmConsentId: !!consent.abdmConsentId,
      });
      return {
        success: true,
        message: consent.abdmConsentId
          ? 'Consent cancelled locally. Note: ABDM revocation of a granted consent is patient-driven via the ABHA app — the HIU has stopped using this consent.'
          : 'Consent request cancelled.',
      };
    } catch (error: any) {
      logger.error('Failed to revoke consent', error);
      throw new AppError(error.message || 'Failed to revoke consent', error.statusCode || 500);
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
    return { success: true, data: consents };
  }

  async getConsentStatusById(consentId: string) {
    const consent = await prisma.consent.findUnique({
      where: { id: consentId },
      select: { id: true, consentId: true, status: true, grantedAt: true, revokedAt: true, createdAt: true, updatedAt: true },
    });
    if (!consent) throw new AppError('Consent not found', 404);
    return { success: true, data: consent };
  }

  async getConsentStats(currentUser?: any) {
    const where: any = {};
    if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
      where.patient = { hospitalId: currentUser.hospitalId };
    }
    const [total, granted, denied, pending, revoked] = await Promise.all([
      prisma.consent.count({ where }),
      prisma.consent.count({ where: { ...where, status: 'GRANTED' } }),
      prisma.consent.count({ where: { ...where, status: 'DENIED' } }),
      prisma.consent.count({ where: { ...where, status: 'REQUESTED' } }),
      prisma.consent.count({ where: { ...where, status: 'REVOKED' } }),
    ]);
    return { success: true, data: { total, granted, denied, pending, revoked } };
  }
}

export default new ConsentService();
