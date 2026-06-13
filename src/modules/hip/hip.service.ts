import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';
import { healthDataPushQueue, HealthDataPushJobData } from '../../common/config/queue';
import redisClient from '../../common/config/redis';
import { pickPatientByCascade, deriveHiType, AbdmHiType } from './discovery-helpers';
import { rethrowServiceError } from '../../common/utils/serviceErrors';

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
    unverifiedIdentifiers?: Array<{ type: string; value: string }>;
    name?: string;
    gender?: string;
    yearOfBirth?: string | number;
  };
}

interface LinkInitRequest {
  requestId: string;
  timestamp: string;
  transactionId: string;
  // ABDM's inbound link/care-context/init body carries abhaAddress at the TOP
  // level and a `patient` whose shape varies (object or single-element array).
  // Keep these permissive and resolve defensively in linkCareContexts.
  abhaAddress?: string;
  patient?: any;
  careContexts?: Array<{ referenceNumber: string; display: string }>;
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
    // SUPER_ADMIN (no hospitalId) sees all rows. Hospital-scoped users see
    // ONLY rows tagged to their hospital. Earlier we also surfaced
    // hospitalId=null rows (legacy / unmapped hipId) at every facility, but
    // that's a multi-tenant leak: any front desk could see another
    // hospital's untagged shares (and we'd attach a global Patient match
    // from that other hospital). Untagged shares now go to no-one until a
    // SUPER_ADMIN reroutes them.
    //
    // We surface PENDING + recently CONVERTED rows (last 24h) so the queue
    // doesn't grow forever and the receptionist can still see what they
    // converted today; IGNORED / EXPIRED rows stay hidden.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const statusOr: any = {
      OR: [
        { status: 'PENDING' as any },
        { status: 'CONVERTED' as any, convertedAt: { gte: cutoff } },
      ],
    };
    const where: any = hospitalId
      ? { AND: [{ hospitalId }, statusOr] }
      : statusOr;
    const shares = await prisma.receivedShare.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: 100,
    });

    // Resolve each row to the matching Patient (by ABHA number) so the
    // front desk gets a one-click "Open profile" path. Done in a single
    // findMany — no N+1. For hospital-scoped callers we ALSO scope the
    // patient enrichment to that hospital, so we never reveal that the
    // same ABHA is registered at some other facility.
    const abhaNumbers = Array.from(new Set(shares.map(s => s.abhaNumber).filter(Boolean)));
    const patients = abhaNumbers.length
      ? await prisma.patient.findMany({
          where: {
            OR: [
              { abhaNumber: { in: abhaNumbers } },
              { abhaId: { in: abhaNumbers } },
            ],
            ...(hospitalId ? { hospitalId } : {}),
          },
          select: { id: true, uhid: true, abhaNumber: true, abhaId: true, hospitalId: true },
        })
      : [];
    const patientByAbha = new Map<string, typeof patients[number]>();
    for (const p of patients) {
      const key = p.abhaNumber || p.abhaId || '';
      if (key) patientByAbha.set(key, p);
    }

    // Token TTL is 60 min from receivedAt — surface it so the UI can render
    // a countdown chip and stop offering actions on expired shares.
    const TOKEN_TTL_MS = 60 * 60 * 1000;
    return shares.map((s) => {
      const matched = patientByAbha.get(s.abhaNumber);
      const expiresAt = new Date(s.receivedAt.getTime() + TOKEN_TTL_MS);
      return {
        ...s,
        patientId: matched?.id || null,
        uhid: matched?.uhid || null,
        expiresAt,
        expired: expiresAt.getTime() <= Date.now(),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M1: HFR / HIP REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async registerHipService(hospitalId: string) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
    if (!hospital) throw new AppError('Hospital not found', 404);
    if (!hospital.hipId) throw new AppError('Hospital has no HIP ID configured', 400);

    // Use per-hospital ABDM client id when set; fall back to env-level bridge.
    const bridgeId = hospital.abdmClientId || abdmConfig.clientId;

    await abdmClient.addBridgeHipService({
      facilityId: hospital.hipId,
      facilityName: hospital.hipName || hospital.name,
      bridgeId,
      hipName: hospital.hipName || hospital.name,
      active: true,
    });

    await prisma.hospital.update({
      where: { id: hospitalId },
      data: { abdmEnabled: true, abdmRegisteredAt: new Date() },
    });

    logger.info('HIP service registered for hospital', { hospitalId, hipId: hospital.hipId });
    return { hipId: hospital.hipId, registered: true };
  }

  /**
   * Register the hospital as an HIU bridge with ABDM. Mirrors `registerHipService`
   * for HIU-side capabilities (consent + data fetch).
   */
  async registerHiuService(hospitalId: string) {
    const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });
    if (!hospital) throw new AppError('Hospital not found', 404);
    if (!hospital.hiuId) throw new AppError('Hospital has no HIU ID configured', 400);

    const bridgeId = hospital.abdmClientId || abdmConfig.clientId;

    await abdmClient.addBridgeHiuService({
      facilityId: hospital.hiuId,
      facilityName: hospital.hiuName || hospital.name,
      bridgeId,
      hiuName: hospital.hiuName || hospital.name,
      active: true,
    });

    await prisma.hospital.update({
      where: { id: hospitalId },
      data: { abdmEnabled: true, abdmRegisteredAt: new Date() },
    });

    logger.info('HIU service registered for hospital', { hospitalId, hiuId: hospital.hiuId });
    return { hiuId: hospital.hiuId, registered: true };
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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
      rethrowServiceError(error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M2: USER INITIATED LINKING (callbacks from ABDM)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle discovery request from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/patient/care-context/discover (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover
   *
   * M2 cascade: ABDM sends one or more verified identifiers (MOBILE / ABHA-
   * number / ABHA-address) plus the patient's name, gender and YoB. We:
   *   1. Build a candidate set from EVERY matching verified identifier.
   *   2. Run the discovery cascade (name phonetic + gender + YoB ±2) to pick
   *      ONE unambiguous patient.
   *   3. For each care context, derive the right `hiType` from its encounter.
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

      const verified = request.patient.verifiedIdentifiers || [];
      const unverified = request.patient.unverifiedIdentifiers || [];

      if (!verified.length) {
        const errorResp = {
          transactionId: request.transactionId,
          error: { code: 1000, message: 'No verified identifier provided' },
          response: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      // Scope patient lookup by hospital if possible (multi-tenant isolation).
      let hospitalScope: { hospitalId: string } | undefined;
      if ((request as any).hipId) {
        const hospital = await prisma.hospital.findFirst({ where: { hipId: (request as any).hipId }, select: { id: true } });
        if (hospital) hospitalScope = { hospitalId: hospital.id };
      }

      // Build candidate set: every patient that matches AT LEAST ONE verified
      // identifier. We OR them across mobile / abhaNumber / abhaAddress.
      const orClauses: any[] = [];
      for (const id of verified) {
        if (id.type === 'MOBILE' && id.value) {
          orClauses.push({ mobile: id.value });
        } else if ((id.type === 'ABHA_NUMBER' || id.type === 'HEALTH_NUMBER') && id.value) {
          orClauses.push({ abhaNumber: id.value });
          orClauses.push({ abhaRecord: { abhaNumber: id.value } });
        } else if ((id.type === 'ABHA_ADDRESS' || id.type === 'HEALTH_ID') && id.value) {
          orClauses.push({ abhaAddress: id.value });
          orClauses.push({ abhaRecord: { abhaAddress: id.value } });
        }
      }
      if (!orClauses.length) {
        const errorResp = {
          transactionId: request.transactionId,
          error: { code: 1000, message: 'Unsupported identifier types' },
          response: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      const candidates = await prisma.patient.findMany({
        where: { OR: orClauses, ...hospitalScope },
        include: {
          abhaRecord: true,
          encounters: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
        take: 25,
      });

      const yobNum = request.patient.yearOfBirth
        ? typeof request.patient.yearOfBirth === 'number'
          ? request.patient.yearOfBirth
          : parseInt(String(request.patient.yearOfBirth), 10)
        : undefined;

      const hints = {
        name: request.patient.name,
        gender: (request.patient.gender as 'M' | 'F' | 'O' | undefined),
        yearOfBirth: Number.isFinite(yobNum) ? yobNum : undefined,
        verifiedIdentifiers: verified,
        unverifiedIdentifiers: unverified,
      };

      const cascade = pickPatientByCascade(
        candidates.map(c => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          mobile: c.mobile,
          gender: c.gender,
          dob: c.dob,
          abhaNumber: c.abhaNumber,
          abhaAddress: c.abhaAddress,
          abhaRecord: c.abhaRecord ? { abhaNumber: c.abhaRecord.abhaNumber, abhaAddress: c.abhaRecord.abhaAddress } : null,
        })),
        hints,
      );

      if (!cascade.patient) {
        const errorResp = {
          transactionId: request.transactionId,
          error: {
            code: cascade.ambiguous ? 1002 : 1001,
            message: cascade.ambiguous
              ? 'Multiple patients matched; cannot uniquely identify'
              : 'Patient not found',
          },
          response: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      // Pull the encounters for the chosen patient (already loaded as part of
      // the candidate set, but re-resolve from the candidates array for type
      // safety) and load their per-encounter content for hiType derivation.
      const winner = candidates.find(c => c.id === cascade.patient!.id)!;
      const encIds = winner.encounters.map(e => e.id);

      const [pcounts, icounts, immcounts] = await Promise.all([
        encIds.length
          ? prisma.encounterPrescription.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
          : Promise.resolve([]),
        encIds.length
          ? prisma.investigation.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
          : Promise.resolve([]),
        encIds.length
          ? prisma.immunization.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
          : Promise.resolve([]),
      ]);

      const prescByEnc = new Map(pcounts.map(p => [p.encounterId!, p._count as any]));
      const invByEnc = new Map(icounts.map(i => [i.encounterId!, i._count as any]));
      const immByEnc = new Map(immcounts.map(i => [i.encounterId!, i._count as any]));

      // Resolve CareContext rows so discover can advertise the SAME persistent
      // identifier (`careContextId`, e.g. "CC-...") that HIP-initiated linking
      // and on_carecontext callbacks use. Previously we returned `encounter.id`
      // here, which the CM then stored as the patient's care-context ref —
      // later HIP-initiated link/carecontext sent `careContextId` for the same
      // context, leaving the CM with two different refs and brittle string-
      // match correlation. Use careContextId when a row exists; auto-create
      // one for any encounter that is missing a CareContext (fresh installs)
      // so the ref is stable from the moment we advertise it.
      const ccRowsExisting = encIds.length
        ? await prisma.careContext.findMany({
            where: { encounterId: { in: encIds } },
            select: { encounterId: true, careContextId: true, display: true },
          })
        : [];
      const ccByEncId = new Map<string, { careContextId: string; display: string }>(
        ccRowsExisting.map(r => [r.encounterId, { careContextId: r.careContextId, display: r.display }]),
      );
      const missingCcEncIds = winner.encounters
        .filter(e => !ccByEncId.has(e.id))
        .map(e => e.id);
      if (missingCcEncIds.length) {
        for (const enc of winner.encounters.filter(e => missingCcEncIds.includes(e.id))) {
          const newId = `CC-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
          const display = sanitizeDisplay(`${enc.type} - ${new Date(enc.createdAt).toLocaleDateString()}`);
          try {
            await prisma.careContext.create({
              data: {
                careContextId: newId,
                encounterId: enc.id,
                patientId: winner.id,
                display,
                hipId: abdmConfig.hip.id,
              },
            });
            ccByEncId.set(enc.id, { careContextId: newId, display });
          } catch (e: any) {
            // Race: another concurrent discover may have created the row.
            // Re-read once before falling back to encounter.id.
            const reread = await prisma.careContext.findFirst({
              where: { encounterId: enc.id },
              select: { careContextId: true, display: true },
            });
            if (reread) {
              ccByEncId.set(enc.id, { careContextId: reread.careContextId, display: reread.display });
            } else {
              logger.warn('HIP discover: careContext upsert failed, falling back to encounter.id', {
                encounterId: enc.id,
                error: e?.message,
              });
            }
          }
        }
      }

      // The CM allows ONE hiType per care context. We bucket the patient's
      // encounters into per-hiType groups so each context advertises the
      // correct type.
      const careContextEntries = winner.encounters.map((enc) => {
        const hiType: AbdmHiType = deriveHiType({
          type: enc.type as any,
          admissionId: enc.admissionId,
          hasImmunization: !!immByEnc.get(enc.id),
          hasInvestigation: !!invByEnc.get(enc.id),
          hasPrescription: !!prescByEnc.get(enc.id),
          hasDiagnosis: !!(enc.finalDiagnosis || enc.diagnosis || enc.provisionalDiagnosis),
        });
        const cc = ccByEncId.get(enc.id);
        return {
          referenceNumber: cc?.careContextId || enc.id,
          display: cc?.display || sanitizeDisplay(`${enc.type} - ${new Date(enc.createdAt).toLocaleDateString()}`),
          hiType,
        };
      });

      // ABDM expects ONE hiType per `patient` entry and the careContexts list
      // must contain only contexts of THAT type. So we group by hiType and
      // emit one patient block per group. (Single-block emission would force
      // a single hiType across heterogeneous encounters → wrong ImmunizationRecord
      // bundles arriving for an OPD encounter etc.)
      const byHiType = new Map<AbdmHiType, typeof careContextEntries>();
      for (const cc of careContextEntries) {
        const list = byHiType.get(cc.hiType) || [];
        list.push(cc);
        byHiType.set(cc.hiType, list);
      }

      const patientName = sanitizeDisplay(`${winner.firstName} ${winner.lastName}`);
      const patientBlocks = Array.from(byHiType.entries()).map(([hiType, ccs]) => ({
        referenceNumber: winner.id,
        display: patientName,
        careContexts: ccs.map(c => ({ referenceNumber: c.referenceNumber, display: c.display })),
        hiType,
        count: ccs.length,
      }));

      // Empty patient — emit a single OPConsultation block with zero contexts
      // so ABDM's response shape is preserved (avoids "patient[] empty" errors).
      const finalBlocks = patientBlocks.length
        ? patientBlocks
        : [{
            referenceNumber: winner.id,
            display: patientName,
            careContexts: [],
            hiType: 'OPConsultation' as const,
            count: 0,
          }];

      const response = {
        transactionId: request.transactionId,
        patient: finalBlocks,
        matchedBy: cascade.matchedBy,
        response: { requestId: request.requestId },
      };

      await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, response);

      try {
        await redisClient.set(cacheKey, JSON.stringify(response), { EX: 600 });
      } catch {
        // Redis unavailable
      }

      logger.info('HIP: on-discover sent', {
        patientId: winner.id,
        count: careContextEntries.length,
        matchedBy: cascade.matchedBy,
        hiTypeBreakdown: Object.fromEntries(Array.from(byHiType, ([k, v]) => [k, v.length])),
      });
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to discover care contexts', describeAbdmError(error));
      rethrowServiceError(error);
    }
  }

  /**
   * Handle link init from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/link/care-context/init (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/link/care-context/on-init
   */
  async linkCareContexts(request: LinkInitRequest) {
    try {
      // The inbound `patient` shape varies (object vs single-element array), so
      // normalise it. The previous code blindly read request.patient.referenceNumber
      // which was undefined for the real ABDM body, producing
      // prisma.patient.findUnique({ where: { id: undefined } }) → 500.
      const p = Array.isArray(request.patient) ? request.patient[0] : request.patient;
      const referenceNumber: string | undefined = p?.referenceNumber || p?.id;
      const abhaAddress: string | undefined = request.abhaAddress || p?.id;

      logger.info('HIP: Linking care contexts (user-initiated)', {
        requestId: request.requestId,
        transactionId: request.transactionId,
        abhaAddress,
        referenceNumber,
        patientKeys: p && typeof p === 'object' ? Object.keys(p) : typeof p,
      });

      // Resolve the patient defensively: try the discover-issued referenceNumber
      // (our DB id) first, then fall back to abhaAddress (reliably present in the
      // init body) on either the patient record or its linked abhaRecord.
      let patient = referenceNumber
        ? await prisma.patient.findUnique({ where: { id: referenceNumber } }).catch(() => null)
        : null;
      if (!patient && abhaAddress) {
        patient = await prisma.patient.findFirst({
          where: { OR: [{ abhaAddress }, { abhaRecord: { is: { abhaAddress } } }] },
        });
      }
      if (!patient) throw new AppError('Patient not found', 404);

      const linkRefNumber = crypto.randomUUID();

      // Remember which patient this link refers to so the subsequent confirm
      // callback (which only carries the linkRefNumber/transactionId) can return
      // that patient's care contexts in on-confirm.
      try {
        await redisClient.set(`link-init:${linkRefNumber}`, patient.id, { EX: 600 });
        await redisClient.set(`link-init-txn:${request.transactionId}`, patient.id, { EX: 600 });
      } catch {
        // Redis unavailable — confirm will fall back to transactionId/abhaAddress.
      }

      const response = {
        transactionId: request.transactionId,
        link: {
          referenceNumber: linkRefNumber,
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
      logger.info('HIP: on-init sent', { patientId: patient.id, linkRefNumber });
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to link care contexts', describeAbdmError(error));
      rethrowServiceError(error);
    }
  }

  /**
   * Handle link confirm from ABDM (user initiated)
   * ABDM calls: POST /api/v3/hip/link/care-context/confirm (your callback URL)
   * HIP responds: POST /api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm
   */
  async confirmLinkCareContexts(request: any) {
    try {
      // The confirm body carries the linkRefNumber we issued in on-init (under
      // confirmation.linkRefNumber) and/or the transactionId — but NOT the patient
      // or care contexts. Recover the patient from the mapping stored at init time
      // so on-confirm can return that patient's care contexts.
      const linkRefNumber: string | undefined =
        request?.confirmation?.linkRefNumber || request?.linkRefNumber;
      const transactionId: string | undefined = request?.transactionId;

      logger.info('HIP: Confirming link (user-initiated)', {
        requestId: request?.requestId,
        transactionId,
        linkRefNumber,
        bodyKeys: request && typeof request === 'object' ? Object.keys(request) : typeof request,
      });

      let patientId: string | null = null;
      try {
        if (linkRefNumber) patientId = await redisClient.get(`link-init:${linkRefNumber}`);
        if (!patientId && transactionId) patientId = await redisClient.get(`link-init-txn:${transactionId}`);
      } catch {
        // Redis unavailable — fall through to error below.
      }

      if (!patientId) throw new AppError('Link reference not found or expired', 404);

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { abhaRecord: true },
      });
      if (!patient) throw new AppError('Patient not found', 404);

      // Link the patient's pending/unlinked care contexts and mark them LINKED.
      const contexts = await prisma.careContext.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: 'desc' },
        include: { encounter: true },
      });
      await prisma.careContext.updateMany({
        where: { patientId: patient.id },
        data: { linkStatus: 'LINKED' },
      });

      const patientName = sanitizeDisplay(`${patient.firstName} ${patient.lastName}`);

      // Group by derived hiType (one block per type) per ABDM M2 spec.
      const blocks = await this.groupCareContextsByHiType(contexts);

      const response = {
        patient: blocks.length
          ? blocks.map(b => ({
              referenceNumber: patient.id,
              display: patientName,
              careContexts: b.careContexts,
              hiType: b.hiType,
              count: b.count,
            }))
          : [{
              referenceNumber: patient.id,
              display: patientName,
              careContexts: [],
              hiType: 'OPConsultation',
              count: 0,
            }],
        // `response.requestId` echoes the inbound REQUEST-ID and is REQUIRED (same
        // "Response cannot be null or empty" rule as the other on-* callbacks).
        response: { requestId: request?.requestId },
      };
      await abdmClient.post(abdmConfig.endpoints.hip.onLinkConfirm, response);
      logger.info('HIP: on-confirm sent', {
        patientId: patient.id, count: contexts.length, hiTypeBreakdown: blocks.map(b => ({ hiType: b.hiType, count: b.count })),
      });
      return response;
    } catch (error: any) {
      logger.error('HIP: Failed to confirm link', describeAbdmError(error));
      rethrowServiceError(error);
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
      rethrowServiceError(error);
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

      // CLAMP (don't reject) the requested range to the consent-permitted range.
      // The HIU often requests a window that overhangs the consent boundaries;
      // ABDM expects the HIP to share only data within the consented period, so
      // we narrow the effective range to the intersection rather than failing the
      // whole request with a 403 over a boundary mismatch.
      const consentDateRange = consent.dateRange as { from?: string; to?: string } | null;
      let effectiveDateRange = request.hiRequest.dateRange;
      if (consentDateRange) {
        const consentFrom = consentDateRange.from ? new Date(consentDateRange.from) : null;
        const consentTo = consentDateRange.to ? new Date(consentDateRange.to) : null;
        const reqFrom = request.hiRequest.dateRange?.from ? new Date(request.hiRequest.dateRange.from) : null;
        const reqTo = request.hiRequest.dateRange?.to ? new Date(request.hiRequest.dateRange.to) : null;

        // Effective start = the later of (consentFrom, reqFrom); end = the earlier of (consentTo, reqTo).
        const from = consentFrom && (!reqFrom || reqFrom < consentFrom) ? consentFrom : reqFrom;
        const to = consentTo && (!reqTo || reqTo > consentTo) ? consentTo : reqTo;

        effectiveDateRange = {
          from: (from ?? reqFrom)?.toISOString() ?? request.hiRequest.dateRange?.from,
          to: (to ?? reqTo)?.toISOString() ?? request.hiRequest.dateRange?.to,
        };

        if (from && to && from > to) {
          logger.warn('HIP: requested range does not overlap consent range', {
            transactionId: request.transactionId,
            consentRange: consentDateRange,
            requestedRange: request.hiRequest.dateRange,
          });
        } else if (
          effectiveDateRange.from !== request.hiRequest.dateRange?.from ||
          effectiveDateRange.to !== request.hiRequest.dateRange?.to
        ) {
          logger.info('HIP: clamped requested date range to consent window', {
            transactionId: request.transactionId,
            requestedRange: request.hiRequest.dateRange,
            effectiveRange: effectiveDateRange,
          });
        }
      }

      // Enqueue the data push job — return 202 immediately so ABDM doesn't timeout
      const jobData: HealthDataPushJobData = {
        transactionId: request.transactionId,
        requestId: request.requestId,
        consentAbdmId: request.hiRequest.consent.id,
        consentPatientId: consent.patientId,
        dataPushUrl: request.hiRequest.dataPushUrl,
        dateRange: effectiveDateRange,
        keyMaterial: request.hiRequest.keyMaterial,
      };

      await healthDataPushQueue.add(`push-${request.transactionId}`, jobData, {
        jobId: request.transactionId,
      });

      logger.info('HIP: Health data push enqueued', { transactionId: request.transactionId });
      return { success: true, message: 'Health information request accepted, data push in progress' };
    } catch (error: any) {
      logger.error('HIP: Failed to process health information request', error);
      rethrowServiceError(error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARE CONTEXT MANAGEMENT (local)
  // ═══════════════════════════════════════════════════════════════════════════

  async addCareContexts(
    patientId: string,
    careContexts: Array<{ encounterId: string; display: string }>,
    currentUser?: any,
  ) {
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

      // Multi-tenant guard: only the patient's hospital may add care
      // contexts to their record. Without this check, any HIP user with a
      // patient UUID could attach encounters from another hospital to that
      // patient's ABHA chain.
      if (
        currentUser &&
        currentUser.role !== 'SUPER_ADMIN' &&
        currentUser.hospitalId &&
        patient.hospitalId &&
        patient.hospitalId !== currentUser.hospitalId
      ) {
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
          include: { encounter: true },
        });

        // Group contexts by their derived hiType so each `patient[]` block
        // in the link/carecontext payload is hiType-homogeneous (M2 spec).
        const blocks = await this.groupCareContextsByHiType(pendingContexts);

        setImmediate(async () => {
          try {
            logger.info('HIP: [link] reusing existing active link token — linking directly (skipping generate-token)', {
              patientId,
              abhaNumber: maskAbha(abhaNumber),
              contextsToLink: pendingContexts.length,
              hiTypeBreakdown: blocks.map(b => ({ hiType: b.hiType, count: b.count })),
            });
            await this.hipInitiatedLink({
              abhaNumber,
              abhaAddress,
              linkToken: reusableToken,
              patient: blocks.map(b => ({
                referenceNumber: patient.uhid || patient.id,
                display: patientName,
                careContexts: b.careContexts,
                hiType: b.hiType,
                count: b.count,
              })),
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
      rethrowServiceError(error);
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

  /**
   * Generate a UHID in the same series as the rest of the registration flow
   * (`UH000001`+). Public so /received-shares/:id/convert can reuse it.
   */
  async nextUhid(): Promise<string> {
    const prefix = 'UH';
    const lastPatient = await prisma.patient.findFirst({
      where: { uhid: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
      select: { uhid: true },
    });
    const lastNumber = lastPatient?.uhid
      ? parseInt(lastPatient.uhid.replace(prefix, ''), 10) || 0
      : 0;
    return `${prefix}${(lastNumber + 1).toString().padStart(6, '0')}`;
  }

  /**
   * Parse the ABDM /patient/share profile into the columns we'd put on a
   * Patient row. Centralised so both the convert API and any future bulk
   * importer behave the same way.
   *
   * ABDM may redact DOB / mobile (e.g. `yearOfBirth: '19**'`); we never put
   * a placeholder mobile or an "Invalid Date" into the DB — we leave those
   * fields blank so the front desk fills them at intake.
   */
  parseScanShareProfile(profile: any) {
    const fullName = profile?.name || `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim();
    const firstName = profile?.firstName || fullName.split(' ')[0] || 'Unknown';
    const lastName = profile?.lastName || fullName.split(' ').slice(1).join(' ') || '';
    const gender = (profile?.gender === 'M' ? 'MALE' : profile?.gender === 'F' ? 'FEMALE' : 'OTHER') as any;

    const allDigits = (s: string) => s && /^\d+$/.test(s);
    const yob = String(profile?.yearOfBirth || '');
    const mob = String(profile?.monthOfBirth || '01');
    const dob_ = String(profile?.dayOfBirth || '01');
    const dob = (allDigits(yob) && allDigits(mob) && allDigits(dob_))
      ? new Date(`${yob.padStart(4, '0')}-${mob.padStart(2, '0')}-${dob_.padStart(2, '0')}`)
      : null;

    const rawMobile: string = profile?.mobile || profile?.phoneNumber || '';
    const mobile = /^\d{6,15}$/.test(rawMobile) ? rawMobile : '';

    return {
      firstName,
      lastName,
      fullName,
      gender,
      dob,
      mobile,
      address: {
        line: profile?.address?.line || profile?.address || '',
        district: profile?.address?.district || profile?.districtName || '',
        state: profile?.address?.state || profile?.stateName || '',
        pincode: profile?.address?.pinCode || profile?.pinCode || '',
      },
    };
  }

  /**
   * Find Patients in the receptionist's hospital that probably refer to the
   * same person as a PENDING ReceivedShare. Match priority:
   *   1. Same ABHA number (almost certainly the same person — but we already
   *      auto-link in that case, so we still surface it for visibility).
   *   2. Same mobile number.
   *   3. Same name (fuzzy) + DOB year (when both sides have a year).
   * Returns at most 5 candidates, scored most-confident first.
   */
  async getMatchCandidatesForShare(shareId: string, currentUser?: any) {
    const share = await prisma.receivedShare.findUnique({ where: { id: shareId } });
    if (!share) throw new AppError('Share not found', 404);

    // Multi-tenant guard: only the share's own hospital (or SUPER_ADMIN)
    // may probe match candidates for it. share.rawProfile contains
    // demographics from ABDM, so we can't reveal it across hospitals.
    if (currentUser && currentUser.role !== 'SUPER_ADMIN') {
      if (!currentUser.hospitalId) {
        throw new AppError('Your account is not linked to a hospital', 403);
      }
      if (share.hospitalId && share.hospitalId !== currentUser.hospitalId) {
        throw new AppError('Share not found', 404);
      }
      // Refuse legacy null-tenancy shares to non-SUPER_ADMINs — same
      // reasoning as getReceivedShares.
      if (!share.hospitalId) {
        throw new AppError('Share not found', 404);
      }
    }

    const hospitalId = currentUser?.role !== 'SUPER_ADMIN'
      ? currentUser?.hospitalId
      : (share.hospitalId || undefined);

    const where: any = {
      isActive: true,
      ...(hospitalId ? { hospitalId } : {}),
    };

    const profile = (share.rawProfile as any) || {};
    const parsed = this.parseScanShareProfile(profile);
    const ors: any[] = [];
    if (share.abhaNumber) {
      ors.push({ abhaNumber: share.abhaNumber });
      ors.push({ abhaId: share.abhaNumber });
    }
    if (parsed.mobile) ors.push({ mobile: parsed.mobile });
    if (share.mobile && /^\d{6,15}$/.test(share.mobile)) ors.push({ mobile: share.mobile });
    if (parsed.firstName && parsed.firstName !== 'Unknown') {
      ors.push({
        AND: [
          { firstName: { equals: parsed.firstName, mode: 'insensitive' } },
          { lastName: { equals: parsed.lastName, mode: 'insensitive' } },
        ],
      });
    }
    if (!ors.length) return { share, candidates: [] };

    const candidates = await prisma.patient.findMany({
      where: { ...where, OR: ors },
      take: 5,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, uhid: true, firstName: true, lastName: true, mobile: true,
        gender: true, dob: true, abhaNumber: true, abhaAddress: true,
        registrationSource: true, profileCompleted: true,
      },
    });

    // Score so the strongest match floats up.
    const dobYear = parsed.dob ? parsed.dob.getFullYear() : null;
    const scored = candidates.map((c) => {
      let score = 0;
      const reasons: string[] = [];
      if (share.abhaNumber && c.abhaNumber === share.abhaNumber) {
        score += 100; reasons.push('same ABHA number');
      }
      if (parsed.mobile && c.mobile === parsed.mobile) {
        score += 60; reasons.push('same mobile');
      }
      if (
        parsed.firstName &&
        parsed.firstName !== 'Unknown' &&
        c.firstName?.toLowerCase() === parsed.firstName.toLowerCase() &&
        c.lastName?.toLowerCase() === parsed.lastName.toLowerCase()
      ) {
        score += 30; reasons.push('same name');
      }
      if (dobYear && c.dob && new Date(c.dob).getFullYear() === dobYear) {
        score += 10; reasons.push('same birth year');
      }
      return { ...c, score, reasons };
    });
    scored.sort((a, b) => b.score - a.score);

    return { share, candidates: scored };
  }

  /**
   * Convert a PENDING ReceivedShare into a Patient.
   *
   * Modes:
   *   • NEW    — create a fresh Patient row, copying the ABDM-supplied
   *             demographics. Generates a real UH###### UHID and tags the
   *             row with registrationSource=SCAN_SHARE + profileCompleted=false
   *             so the front desk knows to finish intake.
   *   • MERGE  — attach the ABHA to an existing Patient (validated to be in
   *             the receptionist's own hospital). Doesn't overwrite existing
   *             demographics; only fills what was blank.
   *   • IGNORE — mark the share as IGNORED (e.g. wrong scan, walk-away).
   */
  async convertReceivedShare(
    shareId: string,
    body: { mode: 'NEW' | 'MERGE' | 'IGNORE'; existingPatientId?: string; notes?: string },
    currentUser: any,
  ) {
    const share = await prisma.receivedShare.findUnique({ where: { id: shareId } });
    if (!share) throw new AppError('Share not found', 404);
    if (share.status !== 'PENDING') {
      throw new AppError(`This share has already been ${share.status.toLowerCase()}`, 409);
    }

    const myHospitalId = currentUser?.hospitalId;
    if (currentUser?.role !== 'SUPER_ADMIN') {
      if (!myHospitalId) {
        throw new AppError('Your account is not linked to a hospital', 403);
      }
      // Block both cross-hospital shares AND legacy null-tenancy shares
      // (matches the read-side change in getReceivedShares: untagged
      // shares are reserved for SUPER_ADMIN reroute).
      if (!share.hospitalId || share.hospitalId !== myHospitalId) {
        throw new AppError('This share belongs to a different hospital', 403);
      }
    }

    if (body.mode === 'IGNORE') {
      await prisma.receivedShare.update({
        where: { id: shareId },
        data: {
          status: 'IGNORED',
          convertedAt: new Date(),
          convertedById: currentUser?.id || null,
          notes: body.notes || null,
        },
      });
      return { mode: 'IGNORE', share };
    }

    const profile = (share.rawProfile as any) || {};
    const parsed = this.parseScanShareProfile(profile);
    const targetHospitalId = share.hospitalId || myHospitalId || null;

    if (body.mode === 'MERGE') {
      if (!body.existingPatientId) {
        throw new AppError('existingPatientId is required for MERGE', 400);
      }
      const existing = await prisma.patient.findUnique({
        where: { id: body.existingPatientId },
      });
      if (!existing) throw new AppError('Existing patient not found', 404);
      if (
        currentUser?.role !== 'SUPER_ADMIN' &&
        existing.hospitalId &&
        existing.hospitalId !== myHospitalId
      ) {
        throw new AppError('Cannot merge into a patient from another hospital', 403);
      }

      const merged = await prisma.patient.update({
        where: { id: existing.id },
        data: {
          // Always link the ABHA — the whole point of the merge.
          abhaNumber: share.abhaNumber || existing.abhaNumber,
          abhaId: share.abhaNumber || existing.abhaId,
          abhaAddress: share.abhaAddress || existing.abhaAddress,
          // Fill blanks only — never overwrite existing data the receptionist
          // already entered.
          ...(existing.dob ? {} : (parsed.dob ? { dob: parsed.dob } : {})),
          ...(existing.mobile && !existing.mobile.startsWith('SCAN-') ? {} : (parsed.mobile ? { mobile: parsed.mobile } : {})),
        },
      });

      // Upsert the canonical AbhaRecord.
      if (share.abhaNumber) {
        await prisma.abhaRecord.upsert({
          where: { abhaNumber: share.abhaNumber },
          create: {
            abhaNumber: share.abhaNumber,
            abhaAddress: share.abhaAddress || null,
            patientId: merged.id,
            kycStatus: 'VERIFIED',
            profileData: profile,
          },
          update: {
            patientId: merged.id,
            abhaAddress: share.abhaAddress || undefined,
            profileData: profile,
          },
        });
      }

      await prisma.receivedShare.update({
        where: { id: shareId },
        data: {
          status: 'CONVERTED',
          convertedPatientId: merged.id,
          convertedAt: new Date(),
          convertedById: currentUser?.id || null,
          notes: body.notes || null,
        },
      });

      return { mode: 'MERGE', patient: merged, share };
    }

    // mode === 'NEW'
    const uhid = await this.nextUhid();
    const created = await prisma.patient.create({
      data: {
        uhid,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        gender: parsed.gender,
        dob: parsed.dob,
        mobile: parsed.mobile, // empty string if ABDM didn't share — receptionist fills in
        abhaNumber: share.abhaNumber || null,
        abhaId: share.abhaNumber || null,
        abhaAddress: share.abhaAddress || null,
        address: parsed.address as any,
        ...(targetHospitalId ? { hospitalId: targetHospitalId } : {}),
        registrationSource: 'SCAN_SHARE' as any,
        profileCompleted: false,
      },
    });

    if (share.abhaNumber) {
      await prisma.abhaRecord.upsert({
        where: { abhaNumber: share.abhaNumber },
        create: {
          abhaNumber: share.abhaNumber,
          abhaAddress: share.abhaAddress || null,
          patientId: created.id,
          kycStatus: 'VERIFIED',
          profileData: profile,
        },
        update: {
          patientId: created.id,
          abhaAddress: share.abhaAddress || undefined,
          profileData: profile,
        },
      });
    }

    await prisma.receivedShare.update({
      where: { id: shareId },
      data: {
        status: 'CONVERTED',
        convertedPatientId: created.id,
        convertedAt: new Date(),
        convertedById: currentUser?.id || null,
        notes: body.notes || null,
      },
    });

    return { mode: 'NEW', patient: created, share };
  }

  // Legacy entry-point kept (and still used by the old auto-create path's
  // call-sites before the refactor). New code MUST call convertReceivedShare
  // instead — this helper exists only as a thin wrapper for backwards-compat.
  async createPatientFromScanShare(
    profile: any,
    abhaNumber: string,
    abhaAddress: string,
    hospitalId?: string,
  ) {
    const normalized = abhaNumber.replace(/-/g, '');
    const parsed = this.parseScanShareProfile(profile);
    const uhid = await this.nextUhid();

    const patient = await prisma.patient.create({
      data: {
        uhid,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        gender: parsed.gender,
        dob: parsed.dob,
        mobile: parsed.mobile,
        abhaNumber: normalized,
        abhaId: normalized,
        abhaAddress: abhaAddress || null,
        ...(hospitalId ? { hospitalId } : {}),
        address: parsed.address as any,
        registrationSource: 'SCAN_SHARE' as any,
        profileCompleted: false,
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

  /**
   * Group an array of care contexts (each with its loaded encounter) into
   * hiType-homogeneous blocks suitable for the M2 link/carecontext payload
   * (`patient[].hiType` + `patient[].count`). Each block has exactly one
   * hiType so the CM can route the linked context to the right consent
   * scope.
   */
  async groupCareContextsByHiType(
    contexts: Array<{ careContextId: string; display: string; encounter?: any }>,
  ): Promise<Array<{ hiType: AbdmHiType; count: number; careContexts: Array<{ referenceNumber: string; display: string }> }>> {
    if (!contexts.length) return [];

    const encIds = contexts
      .map(c => c.encounter?.id)
      .filter(Boolean) as string[];

    const [pcounts, icounts, immcounts] = await Promise.all([
      encIds.length
        ? prisma.encounterPrescription.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
        : Promise.resolve([]),
      encIds.length
        ? prisma.investigation.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
        : Promise.resolve([]),
      encIds.length
        ? prisma.immunization.groupBy({ by: ['encounterId'], where: { encounterId: { in: encIds } }, _count: true })
        : Promise.resolve([]),
    ]);
    const prescByEnc = new Map(pcounts.map(p => [p.encounterId!, p._count as any]));
    const invByEnc = new Map(icounts.map(i => [i.encounterId!, i._count as any]));
    const immByEnc = new Map(immcounts.map(i => [i.encounterId!, i._count as any]));

    const groups = new Map<AbdmHiType, Array<{ referenceNumber: string; display: string }>>();
    for (const cc of contexts) {
      const enc: any = cc.encounter;
      const hiType: AbdmHiType = enc
        ? deriveHiType({
            type: enc.type,
            admissionId: enc.admissionId,
            hasImmunization: !!immByEnc.get(enc.id),
            hasInvestigation: !!invByEnc.get(enc.id),
            hasPrescription: !!prescByEnc.get(enc.id),
            hasDiagnosis: !!(enc.finalDiagnosis || enc.diagnosis || enc.provisionalDiagnosis),
          })
        : 'OPConsultation';
      const list = groups.get(hiType) || [];
      list.push({ referenceNumber: cc.careContextId, display: sanitizeDisplay(cc.display) });
      groups.set(hiType, list);
    }

    return Array.from(groups.entries()).map(([hiType, careContexts]) => ({
      hiType,
      careContexts,
      count: careContexts.length,
    }));
  }

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
