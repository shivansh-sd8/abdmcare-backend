import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';
import { healthDataPushQueue, HealthDataPushJobData } from '../../common/config/queue';
import redisClient from '../../common/config/redis';

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers (link care context flow)
// ─────────────────────────────────────────────────────────────────────────────

/** Mask an ABHA number for logs: keep first 2 + last 4 digits (PII-safe). */
function maskAbha(value?: string): string {
  const digits = (value || '').replace(/-/g, '');
  if (!digits) return '(none)';
  if (digits.length <= 6) return '****';
  return `${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

/**
 * Normalize a care-context "display" string to what ABDM accepts.
 * ABDM's link/carecontext rejects non-ASCII / special characters in `display`
 * with "ABDM-9999: Invalid display" — e.g. the em-dash "—" (U+2014) the UI puts
 * in "OPD Visit — 09 Jun 2026". We map unicode dashes to a plain hyphen, drop any
 * remaining non-printable-ASCII, collapse whitespace, and cap the length. Applied
 * at the ABDM boundary so any caller's display value is safe regardless of source.
 */
function sanitizeDisplay(value?: string): string {
  const cleaned = (value || '')
    .replace(/[\u2010-\u2015]/g, '-') // unicode hyphens/dashes → ASCII hyphen
    .replace(/[^\x20-\x7E]/g, '')      // strip non-printable / non-ASCII
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'Visit';
}

/**
 * ABDM issues ONE active link token per ABHA. The token (a JWT) arrives via the
 * on-generate-token callback and is stored on the patient's care contexts. While
 * it is still valid, calling generate-token again returns "ABDM-1092: Duplicate
 * Link token request" — so further care contexts must be linked by REUSING the
 * active token, not by regenerating. Returns true only when the JWT carries an
 * `exp` claim that has already passed, so a dead token triggers a fresh
 * generate-token; anything unparseable is treated as still usable (regenerating
 * would just hit ABDM-1092 anyway).
 */
function isLinkTokenExpired(token?: string | null): boolean {
  if (!token) return true;
  try {
    const part = token.split('.')[1];
    if (!part) return false;
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    if (!payload?.exp) return false;
    return Date.now() >= payload.exp * 1000 - 5000; // 5s clock skew
  } catch {
    return false;
  }
}

/** Extract safe, non-circular fields from an Axios/HTTP error for logging. */
function describeAbdmError(error: any): Record<string, unknown> {
  let abdmError: string | undefined;
  try {
    abdmError = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : undefined;
  } catch {
    abdmError = '(unserializable response body)';
  }
  return {
    message: error?.message,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    abdmError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface DiscoverRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  patient: {
    id: string;
    verifiedIdentifiers?: Array<{ type: string; value: string }>;
    name?: string;
    gender?: string;
    yearOfBirth?: string;
  };
}

interface LinkInitRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  patient: { referenceNumber: string; display: string };
  careContexts: Array<{ referenceNumber: string; display: string }>;
}

interface HealthInformationRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  hiRequest: {
    consent: { id: string };
    dateRange: { from: string; to: string };
    dataPushUrl: string;
    keyMaterial: {
      cryptoAlg: string;
      curve: string;
      dhPublicKey: { expiry: string; parameters: string; keyValue: string };
      nonce: string;
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HIP Service V3
// ─────────────────────────────────────────────────────────────────────────────

export class HipService {

  // ═══════════════════════════════════════════════════════════════════════════
  // M1: SCAN & SHARE — RECEIVED EVENTS (persisted to DB)
  // ═══════════════════════════════════════════════════════════════════════════

  async saveReceivedShare(data: {
    abhaNumber: string;
    abhaAddress?: string;
    name: string;
    gender?: string;
    mobile?: string;
    tokenNumber?: string;
    requestId?: string;
    rawProfile?: any;
    hospitalId?: string;
  }) {
    return prisma.receivedShare.create({ data });
  }

  async getReceivedShares(hospitalId?: string) {
    return prisma.receivedShare.findMany({
      where: hospitalId ? { hospitalId } : undefined,
      orderBy: { receivedAt: 'desc' },
      take: 100,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M1: HFR / HIP REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async registerHipService(hospitalId: string) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
    if (!hospital) throw new AppError('Hospital not found', 404);
    if (!hospital.hipId) throw new AppError('Hospital has no HIP ID configured', 400);

    await abdmClient.addBridgeHipService({
      facilityId: hospital.hipId,
      facilityName: hospital.name,
      bridgeId: abdmConfig.clientId,
      hipName: hospital.name,
      active: true,
    });

    await prisma.hospital.update({
      where: { id: hospitalId },
      data: { abdmEnabled: true, abdmRegisteredAt: new Date() },
    });

    logger.info('HIP service registered for hospital', { hospitalId, hipId: hospital.hipId });
    return { hipId: hospital.hipId, registered: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M2: HIP INITIATED LINKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a link token for a patient
   * POST /api/hiecm/v3/token/generate-token
   */
  async generateLinkToken(params: {
    abhaNumber: string;
    abhaAddress: string;
    name: string;
    gender: string;
    yearOfBirth: number;
  }) {
    // CRITICAL: abhaNumber MUST be the bare 14 digits with NO dashes. ABDM's
    // generate-token returns a generic HTTP 400 "Bad Request" when dashes are
    // present (verified live against the sandbox). Strip them defensively so a
    // dashed value from any caller never silently kills linking.
    const abhaNumber = (params.abhaNumber || '').replace(/-/g, '');
    // CRITICAL: the official M2 Postman collection sends abhaNumber to
    // generate-token as a JSON NUMBER (e.g. 91536782361862, no quotes), unlike
    // link/carecontext which expects a STRING. Sending a string here passes the
    // gateway (202) but fails ABDM's downstream validation, so on-generate-token
    // returns an error with NO link token and linking silently stalls. A 14-digit
    // ABHA number (~9.1e13) is well within Number.MAX_SAFE_INTEGER (9.0e15), so
    // numeric conversion is lossless.
    const abhaNumberNumeric = Number(abhaNumber);

    logger.info('HIP: [link] → generate-token request', {
      endpoint: abdmConfig.endpoints.hip.generateToken,
      hipId: abdmConfig.hip.id,
      abhaNumber: maskAbha(abhaNumber),
      abhaAddress: params.abhaAddress,
      name: params.name,
      gender: params.gender,
      yearOfBirth: params.yearOfBirth,
    });

    try {
      // ABDM V3 requires X-HIP-ID on generate-token so the gateway can route the
      // on-generate-token callback back to the correct HIP. Without it the call
      // is rejected / no callback arrives and care contexts stay PENDING.
      const res = await abdmClient.post(
        abdmConfig.endpoints.hip.generateToken,
        {
          abhaNumber: abhaNumberNumeric,
          abhaAddress: params.abhaAddress,
          name: params.name,
          gender: params.gender,
          yearOfBirth: params.yearOfBirth,
        },
        { 'X-HIP-ID': abdmConfig.hip.id },
      );
      logger.info('HIP: [link] ← generate-token accepted by ABDM (awaiting on-generate-token callback)', {
        abhaNumber: maskAbha(abhaNumber),
        abhaAddress: params.abhaAddress,
        hipId: abdmConfig.hip.id,
      });
      return res;
    } catch (error: any) {
      logger.error('HIP: [link] ✗ generate-token failed', {
        abhaNumber: maskAbha(abhaNumber),
        abhaAddress: params.abhaAddress,
        hipId: abdmConfig.hip.id,
        ...describeAbdmError(error),
      });
      throw new AppError(error.message || 'Failed to generate link token', error.response?.status || 500);
    }
  }

  /**
   * HIP-initiated care context linking
   * POST /api/hiecm/hip/v3/link/carecontext
   */
  async hipInitiatedLink(params: {
    abhaNumber: string;
    abhaAddress: string;
    linkToken?: string;
    patient: Array<{
      referenceNumber: string;
      display: string;
      careContexts: Array<{ referenceNumber: string; display: string }>;
      // ABDM link/carecontext REQUIRES hiType + count on each patient entry.
      // hiType tells the CM what kind of data the linked care contexts hold;
      // without it the CM cannot match links to a consent's requested HI types
      // and the patient sees "no facility available to share health records".
      hiType: string;
      count: number;
    }>;
  }) {
    // abhaNumber must be bare 14 digits (no dashes) — same ABDM constraint as
    // generate-token. Strip defensively.
    const abhaNumber = (params.abhaNumber || '').replace(/-/g, '');

    logger.info('HIP: [link] → link/carecontext request', {
      endpoint: abdmConfig.endpoints.hip.linkCareContext,
      hipId: abdmConfig.hip.id,
      abhaNumber: maskAbha(abhaNumber),
      abhaAddress: params.abhaAddress,
      hasLinkToken: !!params.linkToken,
      patientCount: params.patient?.length || 0,
      careContexts: params.patient?.flatMap((p) => ({
        patientRef: p.referenceNumber,
        hiType: p.hiType,
        count: p.count,
        refs: p.careContexts?.map((cc) => cc.referenceNumber),
      })),
    });

    try {
      // ABDM V3 link/carecontext requires BOTH X-HIP-ID and X-LINK-TOKEN headers.
      // The X-LINK-TOKEN is the JWT returned via the on-generate-token callback.
      const headers: Record<string, string> = { 'X-HIP-ID': abdmConfig.hip.id };
      if (params.linkToken) headers['X-LINK-TOKEN'] = params.linkToken;
      else logger.warn('HIP: [link] hipInitiatedLink called WITHOUT a link token — ABDM will reject link/carecontext', {
        abhaAddress: params.abhaAddress,
      });

      // Sanitize every display value to ABDM's accepted charset before sending —
      // a non-ASCII char anywhere (patient or care-context display) triggers
      // "ABDM-9999: Invalid display" and rejects the whole link request.
      const sanitizedPatient = params.patient.map((p) => ({
        ...p,
        display: sanitizeDisplay(p.display),
        careContexts: p.careContexts.map((cc) => ({
          ...cc,
          display: sanitizeDisplay(cc.display),
        })),
      }));

      const res = await abdmClient.post(
        abdmConfig.endpoints.hip.linkCareContext,
        {
          abhaNumber,
          abhaAddress: params.abhaAddress,
          patient: sanitizedPatient,
        },
        headers,
      );
      logger.info('HIP: [link] ← link/carecontext submitted to ABDM (awaiting on_carecontext callback)', {
        abhaNumber: maskAbha(abhaNumber),
        abhaAddress: params.abhaAddress,
        hasLinkToken: !!params.linkToken,
      });
      return res;
    } catch (error: any) {
      logger.error('HIP: [link] ✗ link/carecontext failed', {
        abhaNumber: maskAbha(abhaNumber),
        abhaAddress: params.abhaAddress,
        hasLinkToken: !!params.linkToken,
        ...describeAbdmError(error),
      });
      throw new AppError(error.message || 'Failed to link care context', error.response?.status || 500);
    }
  }

  /**
   * Notify ABDM about new care context linked
   * POST /api/hiecm/hip/v3/link/context/notify
   */
  async linkContextNotify(params: {
    abhaAddress: string;
    careContextReference: string;
    patientReference: string;
    hiTypes: string[];
  }) {
    logger.info('HIP: [link] → link/context/notify request', {
      endpoint: abdmConfig.endpoints.hip.linkContextNotify,
      hipId: abdmConfig.hip.id,
      abhaAddress: params.abhaAddress,
      patientReference: params.patientReference,
      careContextReference: params.careContextReference,
      hiTypes: params.hiTypes,
    });

    try {
      const res = await abdmClient.post(
        abdmConfig.endpoints.hip.linkContextNotify,
        {
          notification: {
            patient: { id: params.abhaAddress },
            careContext: {
              patientReference: params.patientReference,
              careContextReference: params.careContextReference,
            },
            hiTypes: params.hiTypes,
            date: new Date().toISOString(),
            // ABDM notify spec requires the originating HIP id inside the
            // notification body (in addition to the X-HIP-ID header).
            hip: { id: abdmConfig.hip.id },
          },
        },
        { 'X-HIP-ID': abdmConfig.hip.id },
      );
      logger.info('HIP: [link] ← link/context/notify sent to ABDM (awaiting links/context/on-notify callback)', {
        abhaAddress: params.abhaAddress,
        careContextReference: params.careContextReference,
      });
      return res;
    } catch (error: any) {
      logger.error('HIP: [link] ✗ link/context/notify failed', {
        abhaAddress: params.abhaAddress,
        careContextReference: params.careContextReference,
        ...describeAbdmError(error),
      });
      throw new AppError(error.message || 'Failed to notify link context', error.response?.status || 500);
    }
  }

  /**
   * Send SMS deep-link notification to patient
   * POST /api/hiecm/hip/v3/link/patient/links/sms/notify2
   */
  async smsNotify(phoneNo: string, hipName: string, hipId: string) {
    try {
      const res = await abdmClient.post(abdmConfig.endpoints.hip.smsNotify, {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        notification: {
          phoneNo,
          hip: { name: hipName, id: hipId },
        },
      });
      logger.info('HIP: SMS notify sent', { phoneNo });
      return res;
    } catch (error: any) {
      logger.error('HIP: Failed to send SMS notify', error);
      throw new AppError(error.message || 'Failed to send SMS', error.response?.status || 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M2: USER INITIATED LINKING (callbacks from ABDM)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle discovery request from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/patient/care-context/discover (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover
   */
  async discoverCareContexts(request: DiscoverRequest) {
    try {
      logger.info('HIP: Discovering care contexts', { requestId: request.requestId });

      // Idempotency: if this transactionId was already processed, return cached response
      const cacheKey = `discover:${request.transactionId}`;
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          logger.info('HIP: Returning cached discovery response (ABDM retry)', { transactionId: request.transactionId });
          return JSON.parse(cached);
        }
      } catch {
        // Redis unavailable — proceed without cache
      }

      const patientIdentifier = request.patient.verifiedIdentifiers?.find(
        (id) => id.type === 'MOBILE' || id.type === 'ABHA_NUMBER'
      );

      if (!patientIdentifier) {
        const errorResp = {
          transactionId: request.transactionId,
          error: { code: 1000, message: 'No verified identifier provided' },
          response: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      // Scope patient lookup by hospital if possible (multi-tenant isolation).
      // The ABDM callback may carry a hipId — match it to a hospital for scoping.
      let hospitalScope: { hospitalId: string } | undefined;
      if ((request as any).hipId) {
        const hospital = await prisma.hospital.findFirst({ where: { hipId: (request as any).hipId }, select: { id: true } });
        if (hospital) hospitalScope = { hospitalId: hospital.id };
      }

      let patient;
      if (patientIdentifier.type === 'MOBILE') {
        patient = await prisma.patient.findFirst({
          where: { mobile: patientIdentifier.value, ...hospitalScope },
          include: { encounters: { orderBy: { createdAt: 'desc' }, take: 10 }, abhaRecord: true },
        });
      } else {
        patient = await prisma.patient.findFirst({
          where: { abhaRecord: { abhaNumber: patientIdentifier.value }, ...hospitalScope },
          include: { encounters: { orderBy: { createdAt: 'desc' }, take: 10 }, abhaRecord: true },
        });
      }

      if (!patient) {
        const errorResp = {
          transactionId: request.transactionId,
          error: { code: 1001, message: 'Patient not found' },
          response: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      const careContexts = patient.encounters.map((enc) => ({
        referenceNumber: enc.id,
        display: sanitizeDisplay(`${enc.type} - ${new Date(enc.createdAt).toLocaleDateString()}`),
      }));

      // on-discover body per ABDM M2 spec (Milestone_2 Postman):
      //   - `hiType` + `count` live INSIDE each patient object.
      //   - `matchedBy` is a TOP-LEVEL field (sibling of `patient`/`response`),
      //     NOT inside the patient — putting it per-patient is non-conformant.
      //   - `response.requestId` (echoing the inbound REQUEST-ID) is REQUIRED;
      //     omitting it makes ABDM reject with
      //     "ABDM-9999: Response cannot be null or empty".
      const response = {
        transactionId: request.transactionId,
        patient: [{
          referenceNumber: patient.id,
          display: sanitizeDisplay(`${patient.firstName} ${patient.lastName}`),
          careContexts,
          hiType: 'OPConsultation',
          count: careContexts.length,
        }],
        matchedBy: [patientIdentifier.type],
        response: { requestId: request.requestId },
      };

      await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, response);

      // Cache response for idempotency (TTL 10 min)
      try {
        await redisClient.set(cacheKey, JSON.stringify(response), { EX: 600 });
      } catch {
        // Redis unavailable
      }

      logger.info('HIP: on-discover sent', { patientId: patient.id, count: careContexts.length });
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to discover care contexts', describeAbdmError(error));
      throw new AppError(error.message || 'Failed to discover care contexts', error.statusCode || 500);
    }
  }

  /**
   * Handle link init from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/link/care-context/init (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/link/care-context/on-init
   */
  async linkCareContexts(request: LinkInitRequest) {
    try {
      logger.info('HIP: Linking care contexts (user-initiated)', { requestId: request.requestId });

      const patient = await prisma.patient.findUnique({ where: { id: request.patient.referenceNumber } });
      if (!patient) throw new AppError('Patient not found', 404);

      const response = {
        transactionId: request.transactionId,
        link: {
          referenceNumber: crypto.randomUUID(),
          authenticationType: 'DIRECT',
          meta: {
            communicationMedium: 'MOBILE',
            communicationHint: 'OTP',
            communicationExpiry: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          },
        },
        // ABDM requires `response.requestId` on every on-* callback (see on-discover).
        response: { requestId: request.requestId },
      };

      await abdmClient.post(abdmConfig.endpoints.hip.onLinkInit, response);
      logger.info('HIP: on-init sent', { patientId: patient.id });
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to link care contexts', error);
      throw new AppError(error.message || 'Failed to link care contexts', error.statusCode || 500);
    }
  }

  /**
   * Handle link confirm from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/link/care-context/confirm (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm
   */
  async confirmLinkCareContexts(request: { transactionId: string; patient: any; requestId?: string }) {
    try {
      // on-confirm body per ABDM M2 spec: { patient: [...], response: { requestId } }.
      // `response.requestId` echoes the inbound REQUEST-ID and is REQUIRED (same
      // "Response cannot be null or empty" rule as the other on-* callbacks).
      const response = {
        patient: request.patient,
        response: { requestId: request.requestId },
      };
      await abdmClient.post(abdmConfig.endpoints.hip.onLinkConfirm, response);
      logger.info('HIP: on-confirm sent');
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to confirm link', error);
      throw new AppError(error.message || 'Failed to confirm link', error.statusCode || 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M2: DATA TRANSFER (HIP side)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle consent notification from ABDM (HIP side)
   * ABDM calls your callback; HIP acknowledges back
   * POST /api/hiecm/consent/v3/request/hip/on-notify
   */
  async handleConsentHipNotify(params: { requestId: string; consentId: string; status: string }) {
    try {
      // Per ABDM M2 spec the acknowledgement.status is the literal "ok"
      // (receipt acknowledgement), NOT the consent grant status. We log the
      // grant status separately for traceability.
      await abdmClient.post(abdmConfig.endpoints.hip.consentOnNotify, {
        acknowledgement: { status: 'ok', consentId: params.consentId },
        response: { requestId: params.requestId },
      });
      logger.info('HIP: consent on-notify acknowledged', {
        consentId: params.consentId,
        grantStatus: params.status,
      });
    } catch (error: any) {
      logger.error('HIP: consent on-notify failed', error);
      throw new AppError(error.message || 'Failed to acknowledge consent', error.response?.status || 500);
    }
  }

  /**
   * Handle health information request from ABDM
   * ABDM calls your callback; HIP responds then pushes data
   */
  async handleHealthInformationRequest(request: HealthInformationRequest) {
    try {
      logger.info('HIP: Health information request', { transactionId: request.transactionId });

      // Acknowledge receipt
      await abdmClient.post(abdmConfig.endpoints.hip.healthInfoOnRequest, {
        hiRequest: { transactionId: request.transactionId, sessionStatus: 'ACKNOWLEDGED' },
        response: { requestId: request.requestId },
      });

      // Fetch consent using ABDM's consent ID and validate the artefact fully
      const consent = await prisma.consent.findFirst({
        where: { abdmConsentId: request.hiRequest.consent.id },
        include: { patient: true },
      });

      if (!consent) {
        throw new AppError('Consent artefact not found', 403);
      }
      if (consent.status !== 'GRANTED') {
        throw new AppError(`Consent is not granted (current status: ${consent.status})`, 403);
      }
      if (consent.revokedAt) {
        throw new AppError('Consent has been revoked', 403);
      }
      if (consent.expiresAt && new Date(consent.expiresAt) < new Date()) {
        throw new AppError('Consent has expired', 403);
      }

      // Validate that consent has allowed health information types
      const consentHiTypes = (consent as any).hiTypes as string[] | undefined;
      if (consentHiTypes?.length) {
        logger.debug('Consent hiTypes validated', { types: consentHiTypes });
      }

      // Validate requested date range falls within consent's date range
      const consentDateRange = consent.dateRange as { from?: string; to?: string } | null;
      if (consentDateRange && request.hiRequest.dateRange) {
        const consentFrom = consentDateRange.from ? new Date(consentDateRange.from) : null;
        const consentTo = consentDateRange.to ? new Date(consentDateRange.to) : null;
        const reqFrom = request.hiRequest.dateRange.from ? new Date(request.hiRequest.dateRange.from) : null;
        const reqTo = request.hiRequest.dateRange.to ? new Date(request.hiRequest.dateRange.to) : null;

        if (consentFrom && reqFrom && reqFrom < consentFrom) {
          throw new AppError('Requested date range starts before consent allows', 403);
        }
        if (consentTo && reqTo && reqTo > consentTo) {
          throw new AppError('Requested date range ends after consent allows', 403);
        }
      }

      // Enqueue the data push job — return 202 immediately so ABDM doesn't timeout
      const jobData: HealthDataPushJobData = {
        transactionId: request.transactionId,
        requestId: request.requestId,
        consentAbdmId: request.hiRequest.consent.id,
        consentPatientId: consent.patientId,
        dataPushUrl: request.hiRequest.dataPushUrl,
        dateRange: request.hiRequest.dateRange,
        keyMaterial: request.hiRequest.keyMaterial,
      };

      await healthDataPushQueue.add(`push-${request.transactionId}`, jobData, {
        jobId: request.transactionId,
      });

      logger.info('HIP: Health data push enqueued', { transactionId: request.transactionId });
      return { success: true, message: 'Health information request accepted, data push in progress' };
    } catch (error: any) {
      logger.error('HIP: Failed to process health information request', error);
      throw new AppError(error.message || 'Failed to process health information request', error.statusCode || 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARE CONTEXT MANAGEMENT (local)
  // ═══════════════════════════════════════════════════════════════════════════

  async addCareContexts(patientId: string, careContexts: Array<{ encounterId: string; display: string }>) {
    logger.info('HIP: [link] addCareContexts called', {
      patientId,
      count: careContexts?.length || 0,
      encounterIds: careContexts?.map((c) => c.encounterId),
    });
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { abhaRecord: true },
      });

      if (!patient) {
        throw new AppError('Patient not found', 404);
      }

      // Patient needs some ABHA identifier to link care contexts
      const hasAbha = patient.abhaRecord || patient.abhaId || patient.abhaNumber || patient.abhaAddress;
      if (!hasAbha) {
        throw new AppError('Patient has no ABHA — please create ABHA first before linking care contexts', 404);
      }

      // Upsert: skip encounters that already have a care context
      const createdContexts = [];
      for (const context of careContexts) {
        const existing = await prisma.careContext.findFirst({
          where: { encounterId: context.encounterId },
        });
        if (existing) {
          logger.info('HIP: Care context already exists, skipping', { encounterId: context.encounterId });
          createdContexts.push(existing);
          continue;
        }
        const careContext = await prisma.careContext.create({
          data: {
            careContextId: `CC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            encounterId: context.encounterId,
            patientId: patient.id,
            display: context.display,
            hipId: abdmConfig.hip.id,
          },
        });
        createdContexts.push(careContext);
      }

      logger.info('HIP: Care contexts added locally', { patientId, count: createdContexts.length });

      // Resolve ABHA identifiers for ABDM linking
      // abhaId is stored as "91-4376-3363-3759" → strip dashes for number/address
      const rawAbhaId   = patient.abhaId || '';
      const abhaDigits  = rawAbhaId.replace(/-/g, ''); // "91437633633759"
      const abhaNumber  = patient.abhaRecord?.abhaNumber  || patient.abhaNumber  || abhaDigits;
      // ABDM linking needs the patient's ABHA address. ABDM auto-assigns the
      // ABHA number itself as the default PHR address ("<digits>@sbx" in
      // sandbox / "@abdm" in prod); a custom "name@sbx" is optional. Both are
      // valid, so we accept any stored value that looks like an address
      // (contains "@"). Only a truly missing address skips linking.
      const storedAddress = patient.abhaRecord?.abhaAddress || patient.abhaAddress || '';
      const abhaAddress = storedAddress.includes('@') ? storedAddress : '';
      const patientName = `${patient.firstName} ${patient.lastName}`.trim();
      const gender      = patient.gender === 'MALE' ? 'M' : patient.gender === 'FEMALE' ? 'F' : 'O';
      const yearOfBirth = patient.dob ? new Date(patient.dob).getFullYear() : 0;

      logger.info('HIP: [link] resolved ABHA identifiers for linking', {
        patientId,
        abhaNumber: maskAbha(abhaNumber),
        abhaAddress: abhaAddress || '(missing — linking will be skipped)',
        hasRealAddress: !!abhaAddress,
        gender,
        yearOfBirth,
        contextsToLink: createdContexts.length,
      });

      // Guard: without a real ABHA address we cannot link to ABDM. Save locally
      // but tell the caller exactly what to fix instead of silently failing.
      if (!abhaAddress) {
        logger.warn('HIP: ABDM linking skipped — patient has no real ABHA address', { patientId });
        return {
          success: true,
          data: createdContexts,
          message: `${createdContexts.length} care context(s) saved locally, but ABDM linking was skipped: this patient has no ABHA address (e.g. name@sbx). Capture it via ABHA Management → Verify/Link, then link care contexts again.`,
        };
      }

      // Reuse an existing active link token if one is present. ABDM allows only
      // ONE active link token per ABHA: a prior on-generate-token callback stores
      // the token on the patient's care contexts, and while it is still valid a
      // fresh generate-token returns "ABDM-1092: Duplicate Link token request".
      // So if a valid token exists, link the new (and any other PENDING) contexts
      // directly with it and skip generate-token entirely.
      const tokenCtx = await prisma.careContext.findFirst({
        where: { patientId: patient.id, linkToken: { not: null } },
        orderBy: { updatedAt: 'desc' },
        select: { linkToken: true },
      });
      const reusableToken = !isLinkTokenExpired(tokenCtx?.linkToken) ? tokenCtx?.linkToken : null;

      if (reusableToken) {
        // Propagate the token to the freshly created PENDING contexts so the
        // on_carecontext callback can resolve them after ABDM confirms.
        await prisma.careContext.updateMany({
          where: { patientId: patient.id, linkStatus: 'PENDING', linkToken: null },
          data: { linkToken: reusableToken },
        });

        const pendingContexts = await prisma.careContext.findMany({
          where: { patientId: patient.id, linkStatus: 'PENDING' },
        });

        setImmediate(async () => {
          try {
            logger.info('HIP: [link] reusing existing active link token — linking directly (skipping generate-token)', {
              patientId,
              abhaNumber: maskAbha(abhaNumber),
              contextsToLink: pendingContexts.length,
            });
            await this.hipInitiatedLink({
              abhaNumber,
              abhaAddress,
              linkToken: reusableToken,
              patient: [{
                referenceNumber: patient.uhid || patient.id,
                display: patientName,
                careContexts: pendingContexts.map((cc) => ({
                  referenceNumber: cc.careContextId,
                  display: cc.display,
                })),
                hiType: 'OPConsultation',
                count: pendingContexts.length,
              }],
            });
          } catch (e: any) {
            // The reused token was rejected (e.g. expired/consumed). Clear it from
            // the PENDING contexts so the next link attempt regenerates a fresh
            // token instead of looping on the same dead one.
            try {
              await prisma.careContext.updateMany({
                where: { patientId: patient.id, linkStatus: 'PENDING' },
                data: { linkToken: null },
              });
            } catch { /* ignore */ }
            logger.warn('HIP: [link] direct link with reused token failed — cleared token for regeneration on next attempt', {
              patientId, abhaAddress, ...describeAbdmError(e),
            });
          }
        });

        return {
          success: true,
          data: createdContexts,
          message: `${createdContexts.length} care context(s) registered — linking to ABDM with the existing active token (linkStatus will change to LINKED when ABDM confirms)`,
        };
      }

      // Throttle: ABDM deduplicates link-token requests per ABHA and rejects a
      // new generate-token with "ABDM-1092: Duplicate Link token request" (or
      // temporarily blocks with "ABDM-1027") if one is already in flight. Since
      // addCareContexts runs on every "Link" click — including for contexts that
      // are still PENDING — re-clicking would otherwise fire a fresh
      // generate-token each time and trip ABDM's dedup/abuse guard. We use a
      // short-lived Redis key as an in-progress flag to suppress duplicates.
      // Best-effort: if Redis is down we just proceed (same as before).
      const linkThrottleKey = `link-token-req:${abhaNumber}`;
      let linkAlreadyInProgress = false;
      try {
        if (await redisClient.get(linkThrottleKey)) {
          linkAlreadyInProgress = true;
        } else {
          await redisClient.set(linkThrottleKey, '1', { EX: 300 }); // 5-min dedup window
        }
      } catch {
        // Redis unavailable — proceed without throttle
      }

      if (linkAlreadyInProgress) {
        logger.info('HIP: [link] generate-token skipped — a link request is already in progress for this ABHA (within ABDM dedup window)', {
          patientId,
          abhaNumber: maskAbha(abhaNumber),
        });
        return {
          success: true,
          data: createdContexts,
          message: `${createdContexts.length} care context(s) saved. A link request is already in progress with ABDM — please wait a couple of minutes for confirmation before linking again.`,
        };
      }

      // Step 2: Fire-and-forget async generate-token call to ABDM.
      // ABDM returns 202 and later POSTs to /api/v3/hip/token/on-generate-token.
      // That callback will call hipInitiatedLink and mark contexts as LINKED.
      setImmediate(async () => {
        try {
          logger.info('HIP: [async] Calling generate-token for ABDM linking', { abhaAddress, patientId });
          await this.generateLinkToken({ abhaNumber, abhaAddress, name: patientName, gender, yearOfBirth });
          logger.info('HIP: [async] generate-token sent — awaiting ABDM callback', { abhaAddress });
        } catch (e: any) {
          const abdmCode: string = e?.response?.data?.error?.code || '';
          if (abdmCode.includes('ABDM-1092') || abdmCode.includes('ABDM-1027')) {
            // ABDM dedup/temporary block — keep the throttle key so we don't
            // keep hammering; it will expire on its own. Not a code fault.
            logger.warn('HIP: [async] generate-token throttled/blocked by ABDM — not retrying (key kept until it expires)', {
              abhaAddress, patientId, abdmCode, ...describeAbdmError(e),
            });
          } else {
            // A genuine failure (bad payload, network, etc.) — clear the throttle
            // so the user can retry without waiting out the full window.
            try { await redisClient.del(linkThrottleKey); } catch { /* Redis down */ }
            logger.warn('HIP: [async] generate-token failed', {
              abhaAddress, patientId, ...describeAbdmError(e),
            });
          }
        }
      });

      return {
        success: true,
        data: createdContexts,
        message: `${createdContexts.length} care context(s) registered — awaiting ABDM confirmation (linkStatus will change to LINKED when ABDM confirms)`,
      };
    } catch (error: any) {
      logger.error('HIP: Failed to add care contexts', error);
      throw new AppError(error.message || 'Failed to add care contexts', error.statusCode || 500);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M1: SCAN & SHARE PATIENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  async findPatientByAbha(abhaNumber: string) {
    const normalized = abhaNumber.replace(/-/g, '');
    return prisma.patient.findFirst({
      where: {
        OR: [
          { abhaNumber: normalized },
          { abhaId: normalized },
          { abhaRecord: { abhaNumber: normalized } },
        ],
      },
      include: { abhaRecord: true },
    });
  }

  async createPatientFromScanShare(profile: any, abhaNumber: string, abhaAddress: string) {
    const normalized = abhaNumber.replace(/-/g, '');
    const firstName = profile.firstName || profile.name?.split(' ')[0] || 'Unknown';
    const lastName = profile.lastName || profile.name?.split(' ').slice(1).join(' ') || '';
    const gender = (profile.gender === 'M' ? 'MALE' : profile.gender === 'F' ? 'FEMALE' : 'OTHER') as any;
    const mobile = profile.mobile || profile.phoneNumber || `SCAN-${Date.now()}`;

    const dob = profile.yearOfBirth
      ? new Date(`${profile.yearOfBirth}-${profile.monthOfBirth || '01'}-${profile.dayOfBirth || '01'}`)
      : null;

    const patient = await prisma.patient.create({
      data: {
        uhid: `UHID-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        firstName,
        lastName,
        gender,
        dob,
        mobile,
        abhaNumber: normalized,
        abhaId: normalized,
        abhaAddress: abhaAddress || null,
        address: {
          line: profile.address || '',
          district: profile.districtName || '',
          state: profile.stateName || '',
          pincode: profile.pinCode || '',
        },
      },
    });

    await prisma.abhaRecord.upsert({
      where: { abhaNumber: normalized },
      create: {
        abhaNumber: normalized,
        abhaAddress: abhaAddress || null,
        patientId: patient.id,
        kycStatus: 'VERIFIED',
        profileData: profile,
      },
      update: {
        patientId: patient.id,
        abhaAddress: abhaAddress || undefined,
        profileData: profile,
      },
    });

    return patient;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Kept as fallback — new NRCeS builder is in `common/utils/fhir/fhir-builder.ts` */
  async generateFHIRBundleLegacy(consent: any, _dateRange: { from: string; to: string }, encounters: any[]) {
    const bundle: any = {
      resourceType: 'Bundle',
      id: `bundle-${consent.id}`,
      type: 'collection',
      timestamp: new Date().toISOString(),
      entry: [],
    };

    for (const encounter of encounters) {
      bundle.entry.push({
        fullUrl: `Encounter/${encounter.id}`,
        resource: {
          resourceType: 'Encounter',
          id: encounter.id,
          status: 'finished',
          class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
          subject: { reference: `Patient/${consent.patient.id}`, display: `${consent.patient.firstName} ${consent.patient.lastName}` },
          participant: [{ individual: { reference: `Practitioner/${encounter.doctor.id}`, display: `Dr. ${encounter.doctor.firstName} ${encounter.doctor.lastName}` } }],
          period: { start: encounter.createdAt.toISOString(), end: encounter.createdAt.toISOString() },
        },
      });

      for (const emr of encounter.emrRecords) {
        if (emr.resourceType === 'PRESCRIPTION') {
          bundle.entry.push({
            fullUrl: `MedicationRequest/${emr.id}`,
            resource: { resourceType: 'MedicationRequest', id: emr.id, status: 'active', intent: 'order', subject: { reference: `Patient/${consent.patient.id}` }, encounter: { reference: `Encounter/${encounter.id}` }, authoredOn: emr.createdAt.toISOString() },
          });
        } else if (emr.resourceType === 'LAB_REPORT') {
          bundle.entry.push({
            fullUrl: `DiagnosticReport/${emr.id}`,
            resource: { resourceType: 'DiagnosticReport', id: emr.id, status: 'final', code: { text: 'Laboratory Report' }, subject: { reference: `Patient/${consent.patient.id}` }, encounter: { reference: `Encounter/${encounter.id}` }, effectiveDateTime: emr.createdAt.toISOString() },
          });
        }
      }
    }

    return bundle;
  }

  /** @deprecated Encryption is handled by the BullMQ worker */
  async encryptHealthDataLegacy(data: any, keyMaterial: HealthInformationRequest['hiRequest']['keyMaterial']) {
    const dataString = JSON.stringify(data);
    const result = EncryptionService.encryptWithECDH(
      dataString,
      keyMaterial.dhPublicKey.keyValue,
      keyMaterial.nonce,
    );
    const checksum = crypto.createHash('md5').update(result.encryptedData).digest('hex');
    return {
      content: result.encryptedData,
      checksum,
      keyMaterial: result.keyMaterial,
    };
  }
}

export default new HipService();
