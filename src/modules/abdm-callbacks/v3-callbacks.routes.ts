import { Router } from 'express';
import consentController from '../consent/consent.controller';
import logger from '../../common/config/logger';
import prisma from '../../common/config/database';
import { asyncHandler } from '../../common/middleware/errorHandler';
import { verifyAbdmCallback } from '../../common/middleware/verifyAbdmCallback';
import { Request, Response } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// V3 callback routes mounted at top-level paths that ABDM expects.
// These do NOT go through /api/v1 — they are ABDM gateway callbacks.
// All callbacks are verified via ABDM JWT from /v3/certs JWKS.
// ─────────────────────────────────────────────────────────────────────────────

// ── Consent callbacks ────────────────────────────────────────────────────────
export const consentV3Routes = Router();

// ABDM sends: POST /api/v3/consent/request/hip/notify (HIP-side consent notification)
consentV3Routes.post('/hip/notify', verifyAbdmCallback, consentController.handleConsentNotification);

// ── HIU Consent callbacks ────────────────────────────────────────────────────
export const hiuConsentV3Routes = Router();

// ABDM sends: POST /api/v3/consent/request/hiu/on-notify (HIU-side — consent grant/deny arrives here)
hiuConsentV3Routes.post('/on-notify', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body;
  logger.info('V3 callback: HIU consent on-notify received', {
    requestId: payload?.requestId,
    status: payload?.notification?.status,
  });

  const notification = payload?.notification;
  if (notification) {
    const statusMap: Record<string, string> = {
      GRANTED: 'GRANTED',
      DENIED: 'DENIED',
      EXPIRED: 'EXPIRED',
      REVOKED: 'REVOKED',
    };
    const mappedStatus = statusMap[notification.status] || notification.status;

    for (const artefact of notification.consentArtefacts || []) {
      try {
        await prisma.consent.updateMany({
          where: { abdmRequestId: notification.consentRequestId },
          data: {
            status: mappedStatus,
            abdmConsentId: artefact.id,
            ...(mappedStatus === 'GRANTED' ? { grantedAt: new Date() } : {}),
            ...(mappedStatus === 'REVOKED' ? { revokedAt: new Date() } : {}),
          },
        });
      } catch (err: any) {
        logger.warn('HIU consent on-notify: failed to update consent', { error: err.message });
      }
    }
  }

  res.status(202).json({ message: 'HIU consent notification acknowledged' });
}));

// ── Link callbacks ───────────────────────────────────────────────────────────
export const linkV3Routes = Router();

// ABDM sends: POST /api/v3/link/on_carecontext (HIP-initiated link confirmation)
linkV3Routes.post('/on_carecontext', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body;
  logger.info('V3 callback: on_carecontext received', { requestId: payload?.requestId });

  const acknowledgement = payload?.acknowledgement;
  if (acknowledgement?.status === 'SUCCESS') {
    // Mark matching care contexts as LINKED
    const patient = payload?.patient;
    if (patient?.careContexts?.length) {
      for (const cc of patient.careContexts) {
        try {
          await prisma.careContext.updateMany({
            where: { careContextId: cc.referenceNumber },
            data: { linkStatus: 'LINKED' },
          });
        } catch (err: any) {
          logger.warn('on_carecontext: failed to update care context status', { ref: cc.referenceNumber, error: err.message });
        }
      }
    }
    logger.info('V3 callback: Care context link confirmed by ABDM');
  } else {
    logger.warn('V3 callback: Care context link failed', { error: payload?.error });
  }

  res.status(202).json({ message: 'Acknowledged' });
}));

// ── Patients callbacks ───────────────────────────────────────────────────────
export const patientsV3Routes = Router();

// ABDM sends: POST /api/v3/patients/sms/on-notify (SMS delivery acknowledgement)
patientsV3Routes.post('/sms/on-notify', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body;
  logger.info('V3 callback: sms/on-notify received', {
    requestId: payload?.resp?.requestId,
    status: payload?.acknowledgement?.status,
  });
  res.status(202).json({ message: 'Acknowledged' });
}));

// ── HIP token callbacks ─────────────────────────────────────────────────────
export const hipTokenV3Routes = Router();

// ABDM sends: POST /api/v3/hip/token/on-generate-token
hipTokenV3Routes.post('/on-generate-token', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body;
  const linkRefNumber = payload?.linkRefNumber;
  const token = payload?.token;
  logger.info('V3 callback: on-generate-token received', {
    requestId: payload?.requestId,
    linkRefNumber,
  });

  // Store the link token against the patient/care context for subsequent hipInitiatedLink
  if (linkRefNumber && token) {
    try {
      await prisma.careContext.updateMany({
        where: { referenceNumber: linkRefNumber },
        data: { linkToken: token },
      });
      logger.info('V3 callback: link token stored', { linkRefNumber });
    } catch (err: any) {
      logger.warn('on-generate-token: failed to store token', { error: err.message });
    }
  }

  res.status(202).json({ message: 'Token received' });
}));
