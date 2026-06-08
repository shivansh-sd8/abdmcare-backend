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

// ── HIU Consent callbacks (ABDM CM → HIU) ────────────────────────────────────
// ABDM appends FIXED sub-paths to the registered callback base URL. Per the
// official M3 Postman collection (and consistent with the working HIP token
// callback /api/v3/hip/token/on-generate-token) these are:
//   POST /api/v3/hiu/consent/request/on-init    → consentRequest.id assigned
//   POST /api/v3/hiu/consent/request/on-status  → status query response
//   POST /api/v3/hiu/consent/request/on-notify  → consent GRANTED/DENIED/REVOKED/EXPIRED
// (The previous build listened at /api/v3/consent/request/hiu/on-notify — a path
//  ABDM never calls — so consent status was stuck on REQUESTED forever.)
export const hiuConsentV3Routes = Router();

const HIU_STATUS_MAP: Record<string, string> = {
  GRANTED: 'GRANTED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  REQUESTED: 'REQUESTED',
};

// on-init: ABDM echoes the REQUEST-ID we sent (response.requestId) and assigns
// consentRequest.id. Persist that id as abdmRequestId so the later on-notify
// (which references consentRequestId == consentRequest.id) can be correlated.
hiuConsentV3Routes.post('/on-init', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const consentRequestId = payload?.consentRequest?.id;
  const echoedRequestId = payload?.response?.requestId || payload?.resp?.requestId;
  logger.info('V3 callback: HIU consent on-init received', { consentRequestId, echoedRequestId, error: payload?.error });

  if (consentRequestId && echoedRequestId) {
    try {
      await prisma.consent.updateMany({
        where: { abdmRequestId: echoedRequestId },
        data: { abdmRequestId: consentRequestId },
      });
    } catch (err: any) {
      logger.warn('HIU consent on-init: failed to persist consentRequest.id', { error: err.message });
    }
  }
  res.status(202).json({ message: 'Acknowledged' });
}));

// on-status: response to a consent status query (consentRequest.{id,status}).
hiuConsentV3Routes.post('/on-status', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const cr = payload?.consentRequest || {};
  logger.info('V3 callback: HIU consent on-status received', { id: cr?.id, status: cr?.status });

  if (cr?.id && cr?.status) {
    const mappedStatus = HIU_STATUS_MAP[cr.status] || cr.status;
    try {
      await prisma.consent.updateMany({
        where: { abdmRequestId: cr.id },
        data: { status: mappedStatus as any },
      });
    } catch (err: any) {
      logger.warn('HIU consent on-status: update failed', { error: err.message });
    }
  }
  res.status(202).json({ message: 'Acknowledged' });
}));

// on-notify: the authoritative consent grant/deny/revoke notification.
// Body: { notification: { consentRequestId, status, consentArtefacts: [{ id }] } }
hiuConsentV3Routes.post('/on-notify', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const notification = payload?.notification || {};
  const consentRequestId = notification.consentRequestId;
  const mappedStatus = HIU_STATUS_MAP[notification.status] || notification.status;
  logger.info('V3 callback: HIU consent on-notify received', {
    requestId: payload?.requestId,
    consentRequestId,
    status: notification.status,
  });

  if (consentRequestId) {
    const artefacts = notification.consentArtefacts || [];
    try {
      await prisma.consent.updateMany({
        where: { abdmRequestId: consentRequestId },
        data: {
          status: mappedStatus,
          ...(artefacts[0]?.id ? { abdmConsentId: artefacts[0].id } : {}),
          ...(mappedStatus === 'GRANTED' ? { grantedAt: new Date() } : {}),
          ...(mappedStatus === 'REVOKED' ? { revokedAt: new Date() } : {}),
        },
      });
      logger.info('HIU consent on-notify: consent updated', { consentRequestId, status: mappedStatus });
    } catch (err: any) {
      logger.warn('HIU consent on-notify: failed to update consent', { error: err.message });
    }
  } else {
    logger.warn('HIU consent on-notify: missing consentRequestId', { keys: Object.keys(payload || {}) });
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
  // ABDM v3 on-generate-token payload structure:
  // { requestId, timestamp, resp: { requestId }, linkToken/token, abhaAddress/abhaNumber }
  const linkToken   = payload?.linkToken || payload?.token;
  const abhaAddress = payload?.abhaAddress || payload?.resp?.abhaAddress;
  const abhaNumber  = payload?.abhaNumber  || payload?.resp?.abhaNumber;

  logger.info('V3 callback: on-generate-token received', {
    requestId:  payload?.requestId,
    abhaAddress,
    hasToken:   !!linkToken,
  });

  if (!linkToken) {
    logger.warn('on-generate-token: no link token in payload', { keys: Object.keys(payload || {}) });
    res.status(202).json({ message: 'No token found' });
    return;
  }

  // Find patient by abhaAddress / abhaNumber
  const abhaDigits = (abhaAddress || '').replace(/@.*$/, '').replace(/-/g, '')
    || (abhaNumber || '').replace(/-/g, '');

  const patient = await prisma.patient.findFirst({
    where: {
      OR: [
        ...(abhaAddress ? [{ abhaAddress }] : []),
        ...(abhaNumber  ? [{ abhaNumber }]  : []),
        ...(abhaDigits  ? [{ abhaId: { contains: abhaDigits.replace(/(\d{2})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4') } }] : []),
        { abhaRecord: { OR: [
          ...(abhaAddress ? [{ abhaAddress }] : []),
          ...(abhaNumber  ? [{ abhaNumber }]  : []),
        ]}},
      ],
    },
    include: { abhaRecord: true },
  });

  if (!patient) {
    logger.warn('on-generate-token: patient not found', { abhaAddress, abhaNumber });
    res.status(202).json({ message: 'Patient not found' });
    return;
  }

  // Store linkToken on all PENDING care contexts for this patient
  await prisma.careContext.updateMany({
    where: { patientId: patient.id, linkStatus: 'PENDING' },
    data: { linkToken },
  });
  logger.info('on-generate-token: stored link token on care contexts', { patientId: patient.id });

  // Automatically trigger hipInitiatedLink with the received token
  setImmediate(async () => {
    try {
      const contexts = await prisma.careContext.findMany({
        where: { patientId: patient.id, linkToken, linkStatus: 'PENDING' },
      });

      if (!contexts.length) {
        logger.info('on-generate-token: no PENDING contexts to link', { patientId: patient.id });
        return;
      }

      const hipService = (await import('../hip/hip.service')).default;
      const patientRef = patient.uhid || patient.id;
      const patientName = `${patient.firstName} ${patient.lastName}`.trim();
      const resolvedAbhaNumber = patient.abhaRecord?.abhaNumber || patient.abhaNumber
        || (patient.abhaId || '').replace(/-/g, '');
      const resolvedAbhaAddress = patient.abhaRecord?.abhaAddress || patient.abhaAddress
        || abhaAddress || `${(patient.abhaId || '').replace(/-/g, '')}@sbx`;

      await hipService.hipInitiatedLink({
        abhaNumber:  resolvedAbhaNumber,
        abhaAddress: resolvedAbhaAddress,
        linkToken,
        patient: [{
          referenceNumber: patientRef,
          display: patientName,
          careContexts: contexts.map(cc => ({
            referenceNumber: cc.careContextId,
            display: cc.display,
          })),
          // hiType tells the CM what data these care contexts hold so it can
          // match them against a consent's requested HI types. OPConsultation
          // is the broadest type for a generic OPD encounter and is what we
          // request in consents, so the linked facility shows up at grant time.
          hiType: 'OPConsultation',
          count: contexts.length,
        }],
      });

      logger.info('on-generate-token: hipInitiatedLink submitted', {
        patientId: patient.id,
        count: contexts.length,
      });
    } catch (e: any) {
      logger.warn('on-generate-token: hipInitiatedLink failed', { message: e?.message });
    }
  });

  res.status(202).json({ message: 'Token received, linking initiated' });
}));
