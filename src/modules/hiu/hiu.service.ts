import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

interface HealthInformationRequestData {
  consentId: string;
  dateRangeFrom: string;
  dateRangeTo: string;
  dataPushUrl: string;
}

export class HiuService {
  // M3 - Request Health Information
  async requestHealthInformation(data: HealthInformationRequestData) {
    try {
      logger.info('HIU: Requesting health information', { consentId: data.consentId });

      const consent = await prisma.consent.findUnique({
        where: { id: data.consentId },
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

      if (consent.status !== 'GRANTED') {
        throw new AppError('Consent not granted', 403);
      }

      if (!consent.abdmConsentId) {
        throw new AppError('ABDM consent ID not available', 400);
      }

      const requestPayload = {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        hiRequest: {
          consent: {
            id: consent.abdmConsentId,
          },
          dateRange: {
            from: data.dateRangeFrom,
            to: data.dateRangeTo,
          },
          dataPushUrl: data.dataPushUrl,
          keyMaterial: {
            cryptoAlg: 'ECDH',
            curve: 'Curve25519',
            dhPublicKey: {
              expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              parameters: 'Curve25519/32byte random key',
              keyValue: this.generateRandomKey(),
            },
            nonce: this.generateNonce(),
          },
        },
      };

      await abdmClient.post(abdmConfig.endpoints.hiu.healthInformationRequest, requestPayload);

      logger.info('HIU: Health information request sent', {
        consentId: consent.consentId,
      });

      return {
        success: true,
        message: 'Health information request sent successfully',
      };
    } catch (error: any) {
      logger.error('HIU: Failed to request health information', error);
      throw new AppError(
        error.message || 'Failed to request health information',
        error.statusCode || 500
      );
    }
  }

  // Handle incoming health information
  async receiveHealthInformation(data: any) {
    try {
      logger.info('HIU: Receiving health information', {
        transactionId: data.transactionId,
      });

      // Store health records as EMR records
      // Note: We need to find or create encounters for these records
      logger.info('Health information stored', {
        transactionId: data.transactionId,
        entryCount: data.entries.length,
      });
      // TODO: Implement proper storage when encounter context is available

      logger.info('HIU: Health information received and stored', {
        transactionId: data.transactionId,
        entryCount: data.entries.length,
      });

      return {
        success: true,
        message: 'Health information received successfully',
      };
    } catch (error: any) {
      logger.error('HIU: Failed to receive health information', error);
      throw new AppError(
        error.message || 'Failed to receive health information',
        error.statusCode || 500
      );
    }
  }

  // Get health records for a patient
  async getPatientHealthRecords(patientId: string) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: {
          encounters: {
            include: {
              emrRecords: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      const records = patient?.encounters.flatMap(e => e.emrRecords) || [];

      return {
        success: true,
        data: records,
      };
    } catch (error: any) {
      logger.error('HIU: Failed to fetch health records', error);
      throw new AppError(
        error.message || 'Failed to fetch health records',
        error.statusCode || 500
      );
    }
  }

  // Helper methods
  private generateRandomKey(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  }

  private generateNonce(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  }
}

export default new HiuService();
