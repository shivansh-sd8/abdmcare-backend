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

interface ConsentNotification {
  requestId: string;
  timestamp: string;
  notification: {
    consentRequestId: string;
    status: string;
    consentArtefacts?: Array<{ id: string }>;
  };
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

      // Resolve the canonical ABHA address/number to use in the ABDM payload
      const resolvedAbhaId = patient.abhaRecord?.abhaAddress
        || patient.abhaRecord?.abhaNumber
        || patient.abhaAddress
        || patient.abhaNumber
        || patient.abhaId
        || data.patientAbhaId;

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
          requester: {
            name: data.requesterName,
            identifier: { type: 'REGNO', value: data.requesterId, system: 'https://www.mciindia.org' },
          },
          hiTypes: data.hiTypes,
          permission: {
            accessMode: 'VIEW',
            dateRange: { from: fromDt, to: toDt },
            dataEraseAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            frequency: { unit: 'HOUR', value: 1, repeats: 0 },
          },
        },
      };

      const abdmResponse = await abdmClient.post(abdmConfig.endpoints.consent.init, requestPayload);

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

      // Also check if ABDM returned an ID synchronously (some versions do)
      const abdmSyncId = abdmResponse?.data?.consentRequest?.id || abdmResponse?.data?.requestId;
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
   * M3: Handle consent notification from ABDM
   */
  async handleConsentNotification(notification: ConsentNotification) {
    try {
      const consentRequestId = notification.notification.consentRequestId;
      logger.info('Processing consent notification', {
        consentRequestId,
        status: notification.notification.status,
      });

      // Look up by abdmRequestId first (ABDM-assigned ID), then fall back to local consentId
      let consent = await prisma.consent.findFirst({
        where: { abdmRequestId: consentRequestId },
      });
      if (!consent) {
        consent = await prisma.consent.findFirst({
          where: { consentId: consentRequestId },
        });
      }

      if (!consent) {
        logger.warn('Consent not found for notification', { consentRequestId });
        return;
      }

      const statusMap: Record<string, string> = {
        GRANTED: 'GRANTED',
        DENIED: 'DENIED',
        EXPIRED: 'EXPIRED',
        REVOKED: 'REVOKED',
      };
      const status = statusMap[notification.notification.status] || 'REQUESTED';

      await prisma.consent.update({
        where: { id: consent.id },
        data: {
          status: status as any,
          abdmConsentId: notification.notification.consentArtefacts?.[0]?.id,
          ...(status === 'GRANTED' ? { grantedAt: new Date() } : {}),
          ...(status === 'REVOKED' ? { revokedAt: new Date() } : {}),
        },
      });

      logger.info('Consent status updated', { consentId: consent.consentId, newStatus: status });
      return { success: true, message: 'Consent notification processed' };
    } catch (error: any) {
      logger.error('Failed to process consent notification', error);
      throw new AppError(error.message || 'Failed to process consent notification', error.statusCode || 500);
    }
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
      if (!consent.abdmConsentId) throw new AppError('Cannot revoke without ABDM consent ID', 400);

      await prisma.consent.update({ where: { id: consentId }, data: { status: 'REVOKED' } });
      logger.info('Consent revoked', { consentId: consent.consentId });
      return { success: true, message: 'Consent revoked successfully' };
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
