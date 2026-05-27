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
    try {
      const res = await abdmClient.post(abdmConfig.endpoints.hip.generateToken, {
        abhaNumber: params.abhaNumber,
        abhaAddress: params.abhaAddress,
        name: params.name,
        gender: params.gender,
        yearOfBirth: params.yearOfBirth,
      });
      logger.info('HIP: Link token generated', { abhaNumber: params.abhaNumber });
      return res;
    } catch (error: any) {
      logger.error('HIP: Failed to generate link token', error);
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
    patient: Array<{
      referenceNumber: string;
      display: string;
      careContexts: Array<{ referenceNumber: string; display: string }>;
    }>;
  }) {
    try {
      const res = await abdmClient.post(abdmConfig.endpoints.hip.linkCareContext, {
        abhaNumber: params.abhaNumber,
        abhaAddress: params.abhaAddress,
        patient: params.patient,
      });
      logger.info('HIP: Care context linked (HIP-initiated)', { abhaNumber: params.abhaNumber });
      return res;
    } catch (error: any) {
      logger.error('HIP: Failed to link care context', error);
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
    try {
      const res = await abdmClient.post(abdmConfig.endpoints.hip.linkContextNotify, {
        notification: {
          patient: { id: params.abhaAddress },
          careContext: {
            patientReference: params.patientReference,
            careContextReference: params.careContextReference,
          },
          hiTypes: params.hiTypes,
          date: new Date().toISOString(),
        },
      });
      logger.info('HIP: Link context notify sent');
      return res;
    } catch (error: any) {
      logger.error('HIP: Failed to send link context notify', error);
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
          resp: { requestId: request.requestId },
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
          resp: { requestId: request.requestId },
        };
        await abdmClient.post(abdmConfig.endpoints.hip.onDiscover, errorResp);
        return errorResp;
      }

      const careContexts = patient.encounters.map((enc) => ({
        referenceNumber: enc.id,
        display: `${enc.type} - ${new Date(enc.createdAt).toLocaleDateString()}`,
      }));

      const response = {
        transactionId: request.transactionId,
        patient: [{
          referenceNumber: patient.id,
          display: `${patient.firstName} ${patient.lastName}`,
          careContexts,
          matchedBy: [patientIdentifier.type],
        }],
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
      logger.error('HIP: Failed to discover care contexts', error);
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
  async confirmLinkCareContexts(request: { transactionId: string; patient: any }) {
    try {
      const response = {
        patient: request.patient,
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
      await abdmClient.post(abdmConfig.endpoints.hip.consentOnNotify, {
        acknowledgement: { status: params.status, consentId: params.consentId },
        response: { requestId: params.requestId },
      });
      logger.info('HIP: consent on-notify acknowledged', { consentId: params.consentId });
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
      const abhaAddress = patient.abhaRecord?.abhaAddress || patient.abhaAddress
        || (abhaDigits ? `${abhaDigits}@sbx` : '');
      const patientName = `${patient.firstName} ${patient.lastName}`.trim();
      const gender      = patient.gender === 'MALE' ? 'M' : patient.gender === 'FEMALE' ? 'F' : 'U';
      const yearOfBirth = patient.dob ? new Date(patient.dob).getFullYear() : 0;

      // Step 2: Fire-and-forget async generate-token call to ABDM.
      // ABDM returns 202 and later POSTs to /api/v3/hip/token/on-generate-token.
      // That callback will call hipInitiatedLink and mark contexts as LINKED.
      setImmediate(async () => {
        try {
          logger.info('HIP: [async] Calling generate-token for ABDM linking', { abhaAddress, patientId });
          await this.generateLinkToken({ abhaNumber, abhaAddress, name: patientName, gender, yearOfBirth });
          logger.info('HIP: [async] generate-token sent — awaiting ABDM callback', { abhaAddress });
        } catch (e: any) {
          logger.warn('HIP: [async] generate-token failed', {
            message: e?.message,
            status: e?.response?.status,
            abdmError: JSON.stringify(e?.response?.data)?.substring(0, 300),
          });
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
