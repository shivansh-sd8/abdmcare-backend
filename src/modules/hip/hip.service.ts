import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import EncryptionService from '../../common/utils/encryption';

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

interface ReceivedShare {
  id: string;
  abhaNumber: string;
  abhaAddress: string;
  name: string;
  gender: string;
  mobile: string;
  tokenNumber: string;
  requestId: string;
  rawProfile: any;
  receivedAt: string;
}

const receivedShares: ReceivedShare[] = [];
const MAX_SHARES = 100;

export class HipService {

  // ═══════════════════════════════════════════════════════════════════════════
  // M1: SCAN & SHARE — RECEIVED EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  async saveReceivedShare(data: Omit<ReceivedShare, 'id' | 'receivedAt'>) {
    const share: ReceivedShare = {
      ...data,
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
    };
    receivedShares.unshift(share);
    if (receivedShares.length > MAX_SHARES) receivedShares.length = MAX_SHARES;
    return share;
  }

  async getReceivedShares() {
    return receivedShares;
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

      let patient;
      if (patientIdentifier.type === 'MOBILE') {
        patient = await prisma.patient.findFirst({
          where: { mobile: patientIdentifier.value },
          include: { encounters: { orderBy: { createdAt: 'desc' }, take: 10 }, abhaRecord: true },
        });
      } else {
        patient = await prisma.patient.findFirst({
          where: { abhaRecord: { abhaNumber: patientIdentifier.value } },
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

      // Fetch consent and health data
      const consent = await prisma.consent.findUnique({
        where: { consentId: request.hiRequest.consent.id },
        include: { patient: true },
      });

      if (!consent || consent.status !== 'GRANTED') {
        throw new AppError('Consent not found or not granted', 403);
      }

      const careContexts = await prisma.careContext.findMany({ where: { patientId: consent.patientId } });
      const careContextIds = careContexts.map((cc) => cc.careContextId);
      const encounters = await prisma.encounter.findMany({
        where: { id: { in: careContextIds }, patientId: consent.patientId },
        include: { doctor: true, emrRecords: true },
      });

      const fhirBundle = await this.generateFHIRBundle(consent, request.hiRequest.dateRange, encounters);
      const encryptedData = await this.encryptHealthData(fhirBundle, request.hiRequest.keyMaterial);

      // Push data to HIU
      await abdmClient.post(request.hiRequest.dataPushUrl, {
        pageNumber: 0,
        pageCount: 1,
        transactionId: request.transactionId,
        entries: [{
          content: encryptedData.content,
          media: 'application/fhir+json',
          checksum: encryptedData.checksum,
          careContextReference: careContexts[0]?.careContextId || '',
        }],
        keyMaterial: request.hiRequest.keyMaterial,
      });

      // Notify completion
      await abdmClient.post(abdmConfig.endpoints.hip.dataFlowNotify, {
        notification: {
          consentId: request.hiRequest.consent.id,
          transactionId: request.transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIP', id: abdmConfig.hip.id },
          statusNotification: { sessionStatus: 'TRANSFERRED', hipId: abdmConfig.hip.id },
        },
      });

      logger.info('HIP: Health data pushed', { transactionId: request.transactionId });
      return { success: true, message: 'Health information sent successfully' };
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

      if (!patient || !patient.abhaRecord) {
        throw new AppError('Patient or ABHA record not found', 404);
      }

      const createdContexts = [];
      for (const context of careContexts) {
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

      logger.info('HIP: Care contexts added', { patientId, count: createdContexts.length });
      return { success: true, data: createdContexts, message: 'Care contexts added successfully' };
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

  private async generateFHIRBundle(consent: any, _dateRange: { from: string; to: string }, encounters: any[]) {
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

  private async encryptHealthData(data: any, _keyMaterial: any) {
    const dataString = JSON.stringify(data);
    const encrypted = EncryptionService.encryptWithAES(dataString);
    const hash = crypto.createHash('sha256').update(dataString).digest('hex');
    return { content: encrypted, checksum: hash };
  }
}

export default new HipService();
