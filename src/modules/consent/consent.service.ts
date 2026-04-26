import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';
import { ConsentPurpose } from '@prisma/client';

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
    consentArtefacts?: Array<{
      id: string;
    }>;
  };
}

export class ConsentService {
  // M3.1 - Create Consent Request
  async createConsentRequest(data: ConsentRequestData) {
    try {
      logger.info('Creating consent request', { patientAbhaId: data.patientAbhaId });

      const patient = await prisma.patient.findFirst({
        where: {
          abhaRecord: {
            abhaNumber: data.patientAbhaId,
          },
        },
        include: {
          abhaRecord: true,
        },
      });

      if (!patient || !patient.abhaRecord) {
        throw new AppError('Patient with ABHA ID not found', 404);
      }

      const consentRequestId = `CR-${Date.now()}`;
      const requestPayload = {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        consent: {
          purpose: {
            text: data.purpose,
            code: 'CAREMGT',
            refUri: 'http://terminology.hl7.org/ValueSet/v3-PurposeOfUse',
          },
          patient: {
            id: data.patientAbhaId,
          },
          hiu: {
            id: abdmConfig.hiu.id,
            name: abdmConfig.hiu.name,
          },
          requester: {
            name: data.requesterName,
            identifier: {
              type: 'REGNO',
              value: data.requesterId,
              system: 'https://www.mciindia.org',
            },
          },
          hiTypes: data.hiTypes,
          permission: {
            accessMode: 'VIEW',
            dateRange: {
              from: data.dateRangeFrom,
              to: data.dateRangeTo,
            },
            dataEraseAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            frequency: {
              unit: 'HOUR',
              value: 1,
              repeats: 0,
            },
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
          dateRange: {
            from: data.dateRangeFrom,
            to: data.dateRangeTo,
          },
          requesterName: data.requesterName,
          requesterId: data.requesterId,
        },
      });

      logger.info('Consent request created successfully', {
        consentId: consent.consentId,
        patientId: patient.id,
      });

      return {
        success: true,
        data: consent,
        message: 'Consent request created successfully',
      };
    } catch (error: any) {
      logger.error('Failed to create consent request', error);
      throw new AppError(
        error.message || 'Failed to create consent request',
        error.statusCode || 500
      );
    }
  }

  // M3.2 - Handle Consent Notification from ABDM
  async handleConsentNotification(notification: ConsentNotification) {
    try {
      logger.info('Processing consent notification', {
        consentRequestId: notification.notification.consentRequestId,
        status: notification.notification.status,
      });

      const consent = await prisma.consent.findFirst({
        where: {
          consentId: notification.notification.consentRequestId,
        },
      });

      if (!consent) {
        logger.warn('Consent not found for notification', {
          consentRequestId: notification.notification.consentRequestId,
        });
        return;
      }

      let status: any = 'REQUESTED';
      if (notification.notification.status === 'GRANTED') {
        status = 'GRANTED';
      } else if (notification.notification.status === 'DENIED') {
        status = 'DENIED';
      } else if (notification.notification.status === 'EXPIRED') {
        status = 'EXPIRED';
      } else if (notification.notification.status === 'REVOKED') {
        status = 'REVOKED';
      }

      await prisma.consent.update({
        where: { id: consent.id },
        data: {
          status: status,
          abdmConsentId: notification.notification.consentArtefacts?.[0]?.id,
        },
      });

      logger.info('Consent status updated', {
        consentId: consent.consentId,
        newStatus: status,
      });

      return {
        success: true,
        message: 'Consent notification processed',
      };
    } catch (error: any) {
      logger.error('Failed to process consent notification', error);
      throw new AppError(
        error.message || 'Failed to process consent notification',
        error.statusCode || 500
      );
    }
  }

  // M3.3 - Fetch Consent Artefact
  async fetchConsentArtefact(consentId: string) {
    try {
      logger.info('Fetching consent artefact', { consentId });

      const consent = await prisma.consent.findUnique({
        where: { id: consentId },
        include: {
          patient: {
            include: {
              abhaRecord: true,
            },
          },
        },
      });

      if (!consent) {
        throw new AppError('Consent not found', 404);
      }

      if (!consent.abdmConsentId) {
        throw new AppError('ABDM consent ID not available', 400);
      }

      const response = await abdmClient.post(abdmConfig.endpoints.consent.fetch, {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        consentId: consent.abdmConsentId,
      });

      logger.info('Consent artefact fetched successfully', {
        consentId: consent.consentId,
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      logger.error('Failed to fetch consent artefact', error);
      throw new AppError(
        error.message || 'Failed to fetch consent artefact',
        error.statusCode || 500
      );
    }
  }

  // Get all consents for a patient
  async getPatientConsents(patientId: string) {
    try {
      const consents = await prisma.consent.findMany({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
      });

      return {
        success: true,
        data: consents,
      };
    } catch (error: any) {
      logger.error('Failed to fetch patient consents', error);
      throw new AppError(
        error.message || 'Failed to fetch patient consents',
        error.statusCode || 500
      );
    }
  }

  // Revoke consent
  async revokeConsent(consentId: string) {
    try {
      const consent = await prisma.consent.findUnique({
        where: { id: consentId },
      });

      if (!consent) {
        throw new AppError('Consent not found', 404);
      }

      if (!consent.abdmConsentId) {
        throw new AppError('Cannot revoke consent without ABDM consent ID', 400);
      }

      // Note: revoke endpoint not in config, using notify as placeholder
      await abdmClient.post(abdmConfig.endpoints.consent.notify, {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        consentId: consent.abdmConsentId,
      });

      await prisma.consent.update({
        where: { id: consentId },
        data: { status: 'REVOKED' },
      });

      logger.info('Consent revoked successfully', { consentId: consent.consentId });

      return {
        success: true,
        message: 'Consent revoked successfully',
      };
    } catch (error: any) {
      logger.error('Failed to revoke consent', error);
      throw new AppError(
        error.message || 'Failed to revoke consent',
        error.statusCode || 500
      );
    }
  }

  // Get all consents
  async getAllConsents(currentUser?: any) {
    try {
      const where: any = {};
      
      // Hospital isolation: Non-SUPER_ADMIN users can only see consents for patients from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.patient = {
          hospitalId: currentUser.hospitalId,
        };
      }

      const consents = await prisma.consent.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              abhaRecord: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return {
        success: true,
        data: consents,
      };
    } catch (error: any) {
      logger.error('Failed to fetch consents', error);
      throw new AppError(
        error.message || 'Failed to fetch consents',
        error.statusCode || 500
      );
    }
  }

  // Get consent statistics
  async getConsentStats(currentUser?: any) {
    try {
      const where: any = {};
      
      // Hospital isolation: Non-SUPER_ADMIN users can only see stats for patients from their hospital
      if (currentUser && currentUser.role !== 'SUPER_ADMIN' && currentUser.hospitalId) {
        where.patient = {
          hospitalId: currentUser.hospitalId,
        };
      }

      const [total, granted, denied, pending, revoked] = await Promise.all([
        prisma.consent.count({ where }),
        prisma.consent.count({ where: { ...where, status: 'GRANTED' } }),
        prisma.consent.count({ where: { ...where, status: 'DENIED' } }),
        prisma.consent.count({ where: { ...where, status: 'REQUESTED' } }),
        prisma.consent.count({ where: { ...where, status: 'REVOKED' } }),
      ]);

      return {
        success: true,
        data: {
          total,
          granted,
          denied,
          pending,
          revoked,
        },
      };
    } catch (error: any) {
      logger.error('Failed to fetch consent stats', error);
      throw new AppError(
        error.message || 'Failed to fetch consent stats',
        error.statusCode || 500
      );
    }
  }
}

export default new ConsentService();
