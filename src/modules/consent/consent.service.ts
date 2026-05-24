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
        where: { abhaRecord: { abhaNumber: data.patientAbhaId } },
        include: { abhaRecord: true },
      });

      if (!patient || !patient.abhaRecord) throw new AppError('Patient with ABHA ID not found', 404);

      const consentRequestId = `CR-${Date.now()}`;
      const requestPayload = {
        consent: {
          purpose: {
            text: data.purpose,
            code: 'CAREMGT',
            refUri: 'http://terminology.hl7.org/ValueSet/v3-PurposeOfUse',
          },
          patient: { id: data.patientAbhaId },
          hiu: { id: abdmConfig.hiu.id },
          requester: {
            name: data.requesterName,
            identifier: { type: 'REGNO', value: data.requesterId, system: 'https://www.mciindia.org' },
          },
          hiTypes: data.hiTypes,
          permission: {
            accessMode: 'VIEW',
            dateRange: { from: data.dateRangeFrom, to: data.dateRangeTo },
            dataEraseAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            frequency: { unit: 'HOUR', value: 1, repeats: 0 },
          },
        },
      };

      await abdmClient.post(abdmConfig.endpoints.consent.init, requestPayload);

      const consent = await prisma.consent.create({
        data: {
          consentId: consentRequestId,
          patientId: patient.id,
          status: 'REQUESTED',
          purpose: data.purpose as ConsentPurpose,
          hiTypes: data.hiTypes,
          dateRange: { from: data.dateRangeFrom, to: data.dateRangeTo },
          requesterName: data.requesterName,
          requesterId: data.requesterId,
        },
      });

      logger.info('Consent request created', { consentId: consent.consentId });
      return { success: true, data: consent, message: 'Consent request created successfully' };
    } catch (error: any) {
      logger.error('Failed to create consent request', error);
      throw new AppError(error.message || 'Failed to create consent request', error.statusCode || 500);
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
      logger.info('Processing consent notification', {
        consentRequestId: notification.notification.consentRequestId,
        status: notification.notification.status,
      });

      const consent = await prisma.consent.findFirst({
        where: { consentId: notification.notification.consentRequestId },
      });

      if (!consent) {
        logger.warn('Consent not found for notification', { consentRequestId: notification.notification.consentRequestId });
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
