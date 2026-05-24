import crypto from 'crypto';
import prisma from '../../common/config/database';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { AppError } from '../../common/middleware/errorHandler';
import logger from '../../common/config/logger';

// ─────────────────────────────────────────────────────────────────────────────
// HIU Service V3 (M3 — Health Information User)
// ─────────────────────────────────────────────────────────────────────────────

export class HiuService {

  /**
   * Request health information from HIP via ABDM
   * POST /api/hiecm/data-flow/v3/health-information/request
   */
  async requestHealthInformation(data: {
    consentId: string;
    dateRangeFrom: string;
    dateRangeTo: string;
    dataPushUrl: string;
  }) {
    try {
      logger.info('HIU: Requesting health information', { consentId: data.consentId });

      const consent = await prisma.consent.findUnique({
        where: { id: data.consentId },
        include: { patient: { include: { abhaRecord: true } } },
      });

      if (!consent) throw new AppError('Consent not found', 404);
      if (consent.status !== 'GRANTED') throw new AppError('Consent not granted', 403);
      if (!consent.abdmConsentId) throw new AppError('ABDM consent ID not available', 400);

      const requestPayload = {
        hiRequest: {
          consent: { id: consent.abdmConsentId },
          dateRange: { from: data.dateRangeFrom, to: data.dateRangeTo },
          dataPushUrl: data.dataPushUrl || `${abdmConfig.callbackUrl}/api/v3/hiu/data/notification`,
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

      await abdmClient.post(abdmConfig.endpoints.hiu.healthInfoRequest, requestPayload);

      logger.info('HIU: Health information request sent', { consentId: consent.consentId });
      return { success: true, message: 'Health information request sent successfully' };
    } catch (error: any) {
      logger.error('HIU: Failed to request health information', error);
      throw new AppError(error.message || 'Failed to request health information', error.statusCode || 500);
    }
  }

  /**
   * Handle consent notification for HIU
   * POST /api/hiecm/consent/v3/request/hiu/on-notify
   */
  async consentOnNotify(params: { requestId: string; consentIds: Array<{ status: string; consentId: string }> }) {
    try {
      await abdmClient.post(abdmConfig.endpoints.hiu.consentOnNotify, {
        acknowledgement: params.consentIds.map(c => ({ status: c.status, consentId: c.consentId })),
        response: { requestId: params.requestId },
      });
      logger.info('HIU: consent on-notify acknowledged');
    } catch (error: any) {
      logger.error('HIU: consent on-notify failed', error);
      throw new AppError(error.message || 'Failed to acknowledge consent', error.response?.status || 500);
    }
  }

  /**
   * Send data flow completion notification
   * POST /api/hiecm/data-flow/v3/health-information/notify
   */
  async dataFlowNotify(params: { consentId: string; transactionId: string; status: string }) {
    try {
      await abdmClient.post(abdmConfig.endpoints.hiu.dataFlowNotify, {
        notification: {
          consentId: params.consentId,
          transactionId: params.transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIU', id: abdmConfig.hiu.id },
          statusNotification: { sessionStatus: params.status, hipId: '' },
        },
      });
      logger.info('HIU: data flow notify sent');
    } catch (error: any) {
      logger.error('HIU: data flow notify failed', error);
      throw new AppError(error.message || 'Failed to send data flow notification', error.response?.status || 500);
    }
  }

  /**
   * Handle incoming health data pushed by HIP
   */
  async receiveHealthInformation(data: any) {
    try {
      logger.info('HIU: Receiving health information', { transactionId: data.transactionId });

      // TODO: Decrypt and store health records once ECDH key exchange is implemented
      logger.info('HIU: Health information received', {
        transactionId: data.transactionId,
        entryCount: data.entries?.length || 0,
      });

      return { success: true, message: 'Health information received successfully' };
    } catch (error: any) {
      logger.error('HIU: Failed to receive health information', error);
      throw new AppError(error.message || 'Failed to receive health information', error.statusCode || 500);
    }
  }

  /**
   * Get health records for a patient from local DB
   */
  async getPatientHealthRecords(patientId: string) {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { encounters: { include: { emrRecords: true }, orderBy: { createdAt: 'desc' } } },
      });
      const records = patient?.encounters.flatMap(e => e.emrRecords) || [];
      return { success: true, data: records };
    } catch (error: any) {
      logger.error('HIU: Failed to fetch health records', error);
      throw new AppError(error.message || 'Failed to fetch health records', error.statusCode || 500);
    }
  }

  private generateRandomKey(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  private generateNonce(): string {
    return crypto.randomBytes(32).toString('base64');
  }
}

export default new HiuService();
