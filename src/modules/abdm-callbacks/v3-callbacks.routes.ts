import { Router } from 'express';
import consentController from '../consent/consent.controller';
import logger from '../../common/config/logger';
import prisma from '../../common/config/database';
import { asyncHandler } from '../../common/middleware/errorHandler';
import { verifyAbdmCallback } from '../../common/middleware/verifyAbdmCallback';
import { Request, Response } from 'express';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import { purgeByAbdmConsentId } from '../hiu/consent-compliance';

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
//   POST /api/v3/hiu/consent/request/notify     → SAME payload as on-notify; ABDM
//      gateway in production observed sending to /notify (no `on-` prefix), since
//      this is a CM-INITIATED state-change push (mirrors the HIP-side
//      /api/v3/consent/request/hip/notify which has always lived without `on-`).
//      We register the handler at BOTH paths — the previous /on-notify-only
//      registration silently fell through to the generic /api/v3/hiu router below
//      which is `authenticate`-protected, so production was 401-ing and consent
//      status was stuck on REQUESTED forever.
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

// on-notify / notify: the authoritative consent grant/deny/revoke notification.
// Body: { notification: { consentRequestId, status, consentArtefacts: [{ id }] } }
const hiuConsentNotifyHandler = asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const notification = payload?.notification || {};
  const consentRequestId = notification.consentRequestId;
  const mappedStatus = HIU_STATUS_MAP[notification.status] || notification.status;
  const inboundRequestId = (req.headers['request-id'] as string) || payload?.requestId;
  logger.info('V3 callback: HIU consent on-notify received', {
    requestId: inboundRequestId,
    consentRequestId,
    status: notification.status,
  });

  if (consentRequestId) {
    const artefacts = notification.consentArtefacts || [];
    const firstArtefactId = artefacts[0]?.id;
    try {
      // Race-safe match: a prior /on-init may not yet have rewritten our local
      // `abdmRequestId` from our outbound UUID to the CM's consentRequest.id,
      // so a notify that arrives before init lands won't match by abdmRequestId
      // alone. Fall back to abdmConsentId (consent artefact id) when present.
      const updated = await prisma.consent.updateMany({
        where: {
          OR: [
            { abdmRequestId: consentRequestId },
            ...(firstArtefactId ? [{ abdmConsentId: firstArtefactId }] : []),
          ],
        },
        data: {
          status: mappedStatus,
          ...(firstArtefactId ? { abdmConsentId: firstArtefactId } : {}),
          ...(mappedStatus === 'GRANTED' ? { grantedAt: new Date() } : {}),
          ...(mappedStatus === 'REVOKED' ? { revokedAt: new Date() } : {}),
        },
      });
      logger.info('HIU consent on-notify: consent updated', {
        consentRequestId,
        status: mappedStatus,
        rowsUpdated: updated.count,
      });

      // ── M3 compliance: outbound gateway ACK ───────────────────────────────
      // ABDM expects the HIU to ack receipt of the state-change push at
      //   POST /consent/v3/request/hiu/on-notify
      // with `acknowledgement: [{ status, consentId }]`. Without this the CM
      // retries the notification — the HIP side has always done this; the HIU
      // path was missing it (orphan service method existed but unwired).
      if (firstArtefactId) {
        try {
          const hiuService = (await import('../hiu/hiu.service')).default;
          await hiuService.consentOnNotify({
            requestId: inboundRequestId || consentRequestId,
            consentIds: artefacts
              .filter((a: any) => a?.id)
              .map((a: any) => ({ status: 'ok', consentId: a.id })),
          });
        } catch (ackErr: any) {
          logger.warn('HIU consent on-notify: outbound ACK failed', { message: ackErr?.message });
        }
      }

      // ── On GRANT: auto-fetch artefact body so records can be requested ────
      // Without the artefact body in our DB, the UI has nothing to show until
      // a clinician manually clicks "Refresh". Fire-and-forget to keep the
      // callback fast — the on-fetch handler will populate `artefactBody` /
      // `artefactFetchedAt` / `expiresAt` when the body lands.
      if (mappedStatus === 'GRANTED' && firstArtefactId) {
        setImmediate(async () => {
          try {
            await abdmClient.post(abdmConfig.endpoints.consent.fetch, {
              consentId: firstArtefactId,
            });
            logger.info('HIU consent on-notify: artefact fetch dispatched', { abdmConsentId: firstArtefactId });
          } catch (fetchErr: any) {
            logger.warn('HIU consent on-notify: artefact fetch failed', { message: fetchErr?.message });
          }
        });
      }

      // ── M3 compliance: REVOKED / EXPIRED → purge data ─────────────────────
      // ABDM HIU Guidelines: once a consent is no longer GRANTED, the HIU MUST
      // wipe the decryption key + any health records pulled under it. We run
      // this in the same request because (a) the cascade is small and bounded,
      // (b) leaving a gap between status flip and purge means a clinician who
      // reads in those seconds gets unauthorised data. If anything fails the
      // purge is retried by the consent-expiry sweeper (Phase 3).
      if (mappedStatus === 'REVOKED' || mappedStatus === 'EXPIRED') {
        const purgeKeys: string[] = [];
        if (consentRequestId) purgeKeys.push(consentRequestId);
        for (const a of artefacts) {
          if (a?.id) purgeKeys.push(a.id);
        }
        try {
          for (const key of purgeKeys) {
            const results = await purgeByAbdmConsentId(key);
            if (results.length) {
              logger.info('HIU consent on-notify: data purged', {
                key,
                count: results.length,
                totalRecords: results.reduce((s, r) => s + r.externalRecordsDeleted, 0),
                totalKeyPairs: results.reduce((s, r) => s + r.keyPairsDeleted, 0),
              });
            }
          }
        } catch (purgeErr: any) {
          // Never throw — a purge miss is recovered by the sweeper. We MUST ack
          // the callback or ABDM retries it forever.
          logger.error('HIU consent on-notify: purge failed', {
            error: purgeErr?.message,
            keys: purgeKeys,
          });
        }
      }
    } catch (err: any) {
      logger.warn('HIU consent on-notify: failed to update consent', { error: err.message });
    }
  } else {
    logger.warn('HIU consent on-notify: missing consentRequestId', { keys: Object.keys(payload || {}) });
  }

  res.status(202).json({ message: 'HIU consent notification acknowledged' });
});

// Mount the same handler at both paths to be defensive against ABDM gateway
// variation (`/on-notify` per old M3 docs, `/notify` per current production
// gateway behaviour observed in logs).
hiuConsentV3Routes.post('/on-notify', verifyAbdmCallback, hiuConsentNotifyHandler);
hiuConsentV3Routes.post('/notify', verifyAbdmCallback, hiuConsentNotifyHandler);

// ── HIU on-fetch (consent artefact body delivery) ────────────────────────────
// ABDM spec (ndhm-hiu §/v0.5/consents/on-fetch): after the HIU calls
// /consent/v3/fetch, the gateway delivers the FULL artefact body asynchronously
// to /consents/on-fetch. The body must be persisted so the HIU can re-validate
// scope (hiTypes, dateRange, expiry, signature) at every read. Without this
// router the artefact never lands and downstream code can only see the half-
// populated grant from on-notify.
//
// V3 path: POST /api/v3/hiu/consents/on-fetch
// Body shape: { consent: { status, consentDetail: { consentId, patient,
//                hip, careContexts[], hiTypes[], permission{} },
//                signature }, error?, response: { requestId } }
export const hiuConsentsOnFetchRoutes = Router();

hiuConsentsOnFetchRoutes.post('/on-fetch', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const consentEnvelope = payload?.consent || {};
  const detail = consentEnvelope?.consentDetail || {};
  const abdmConsentId = detail?.consentId || consentEnvelope?.consentId;
  const status = consentEnvelope?.status;

  logger.info('V3 callback: HIU consents on-fetch received', {
    abdmConsentId,
    status,
    hasError: !!payload?.error,
  });

  if (payload?.error) {
    logger.warn('HIU on-fetch: ABDM error in artefact response', { error: payload.error });
    res.status(202).json({ message: 'Acknowledged' });
    return;
  }

  if (!abdmConsentId) {
    logger.warn('HIU on-fetch: missing consentId', { keys: Object.keys(payload || {}) });
    res.status(202).json({ message: 'Acknowledged' });
    return;
  }

  try {
    // Persist the full artefact body so it survives restarts and is auditable.
    // Update by abdmConsentId (the local row may have been created with a
    // different abdmRequestId on grant — we match either).
    const updated = await prisma.consent.updateMany({
      where: {
        OR: [
          { abdmConsentId },
          { abdmRequestId: abdmConsentId },
        ],
      },
      data: {
        artefactBody: payload as any,
        artefactFetchedAt: new Date(),
        // If ABDM is delivering the artefact for an unmapped abdmConsentId,
        // back-fill it now so subsequent on-notify cascade matches it.
        ...(abdmConsentId ? { abdmConsentId } : {}),
        // The artefact body authoritatively defines the granted scope; clamp
        // hiTypes / dateRange to what was actually granted (the original
        // request may have been narrower or wider).
        ...(Array.isArray(detail?.hiTypes) && detail.hiTypes.length ? { hiTypes: detail.hiTypes } : {}),
        ...(detail?.permission?.dateRange ? { dateRange: detail.permission.dateRange } : {}),
        ...(detail?.permission?.dataEraseAt ? { expiresAt: new Date(detail.permission.dataEraseAt) } : {}),
      },
    });
    logger.info('HIU on-fetch: artefact persisted', { abdmConsentId, rowsUpdated: updated.count });

    // ── Auto-fire health-information request ──────────────────────────────
    // Now that we have the granted dateRange in the DB, the user's "fetch
    // records" step is fully derivable — there's no human input needed.
    // Pull data immediately so records appear in the patient profile without
    // a clinician hunting for a "Request Records" button. We guard against
    // re-pulling: if any records already exist for this consent OR the
    // keypair is in flight (set by the previous request and not yet wiped),
    // skip — the user can manually re-pull from the UI.
    setImmediate(async () => {
      try {
        const consent = await prisma.consent.findFirst({
          where: { abdmConsentId },
          select: { id: true, status: true, purgedAt: true },
        });
        if (!consent || consent.status !== 'GRANTED' || consent.purgedAt) {
          return;
        }
        const [recordCount, keyPair] = await Promise.all([
          prisma.externalHealthRecord.count({ where: { consentId: abdmConsentId } }),
          prisma.consentKeyPair.findUnique({ where: { consentId: abdmConsentId } }),
        ]);
        if (recordCount > 0 || keyPair) {
          logger.info('HIU on-fetch: auto-pull skipped (already pulled or in-flight)', {
            abdmConsentId,
            recordCount,
            inFlight: !!keyPair,
          });
          return;
        }
        const hiuService = (await import('../hiu/hiu.service')).default;
        await hiuService.requestHealthInformation({ consentId: consent.id });
        logger.info('HIU on-fetch: auto-pull dispatched', { abdmConsentId, localConsentId: consent.id });
      } catch (autoErr: any) {
        // Non-fatal: the user can manually re-pull from the UI.
        logger.warn('HIU on-fetch: auto-pull failed', { abdmConsentId, message: autoErr?.message });
      }
    });
  } catch (err: any) {
    logger.error('HIU on-fetch: failed to persist artefact', { error: err?.message, abdmConsentId });
  }

  res.status(202).json({ message: 'Artefact stored' });
}));

// ── Link callbacks ───────────────────────────────────────────────────────────
export const linkV3Routes = Router();

// ABDM sends: POST /api/v3/link/on_carecontext (HIP-initiated link confirmation)
linkV3Routes.post('/on_carecontext', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body;
  logger.info('V3 callback: on_carecontext received', {
    requestId: payload?.requestId,
    status: payload?.acknowledgement?.status,
    error: payload?.error,
  });

  const acknowledgement = payload?.acknowledgement;
  if (acknowledgement?.status === 'SUCCESS') {
    // Mark matching care contexts as LINKED
    const patient = payload?.patient;
    const linkedRefs: string[] = [];
    if (patient?.careContexts?.length) {
      for (const cc of patient.careContexts) {
        try {
          await prisma.careContext.updateMany({
            where: { careContextId: cc.referenceNumber },
            data: { linkStatus: 'LINKED' },
          });
          linkedRefs.push(cc.referenceNumber);
        } catch (err: any) {
          logger.warn('on_carecontext: failed to update care context status', { ref: cc.referenceNumber, error: err.message });
        }
      }
    }
    logger.info('V3 callback: Care context link confirmed by ABDM', { linkedRefs });

    // CORRECT ORDERING: now that a link exists, notify the CM about the newly
    // linked care contexts. Doing this earlier (e.g. from the frontend right
    // after addCareContexts) caused "ABDM-1006: No links found for the patient
    // in the given HIP" because no link existed yet. Fire-and-forget so we
    // still ACK ABDM within the callback timeout.
    if (linkedRefs.length) {
      setImmediate(async () => {
        try {
          const ctx = await prisma.careContext.findFirst({
            where: { careContextId: linkedRefs[0] },
            include: { patient: { include: { abhaRecord: true } } },
          });
          const p = ctx?.patient;
          const abhaAddress = p?.abhaRecord?.abhaAddress || p?.abhaAddress || '';
          const patientReference = p?.uhid || ctx?.patientId || '';
          if (!abhaAddress || !patientReference) {
            logger.warn('on_carecontext: cannot send link/context/notify — missing abhaAddress/patientReference', {
              linkedRefs, hasAddress: !!abhaAddress, hasPatientRef: !!patientReference,
            });
            return;
          }
          const hipService = (await import('../hip/hip.service')).default;
          // Derive the per-context hiType from each linked encounter so the CM
          // gets the right type for each care context (was previously a fixed
          // ['OPConsultation','Prescription','DiagnosticReport'] for ALL).
          const { deriveHiType } = await import('../hip/discovery-helpers');

          for (const ref of linkedRefs) {
            const cc = await prisma.careContext.findFirst({
              where: { careContextId: ref },
              include: { encounter: true },
            });
            const enc: any = cc?.encounter;
            let hiTypes: string[] = ['OPConsultation'];
            if (enc) {
              const [hasInv, hasPresc, hasImm] = await Promise.all([
                prisma.investigation.count({ where: { encounterId: enc.id } }),
                prisma.encounterPrescription.count({ where: { encounterId: enc.id } }),
                prisma.immunization.count({ where: { encounterId: enc.id } }),
              ]);
              const hi = deriveHiType({
                type: enc.type,
                admissionId: enc.admissionId,
                hasImmunization: !!hasImm,
                hasInvestigation: !!hasInv,
                hasPrescription: !!hasPresc,
                hasDiagnosis: !!(enc.finalDiagnosis || enc.diagnosis || enc.provisionalDiagnosis),
              });
              hiTypes = [hi];
            }
            await hipService.linkContextNotify({
              abhaAddress,
              careContextReference: ref,
              patientReference,
              hiTypes,
            });
          }
          logger.info('on_carecontext: link/context/notify sent for linked contexts', { count: linkedRefs.length });
        } catch (e: any) {
          logger.warn('on_carecontext: link/context/notify failed', { message: e?.message });
        }
      });
    }
  } else {
    logger.warn('V3 callback: Care context link failed', { error: payload?.error });
  }

  res.status(202).json({ message: 'Acknowledged' });
}));

// ── Links (deep-linking) callbacks ───────────────────────────────────────────
// ABDM sends: POST /api/v3/links/context/on-notify  (note the plural "links").
// This is the CM's acknowledgement for our HIP `link/context/notify` call
// (deep-linking notification that new care contexts are available). Body shape:
// { acknowledgement: { status, careContexts? }, error, response: { requestId } }.
// Previously unrouted → returned 404 to ABDM. We ACK 202; if the CM confirms
// SUCCESS with care-context references, mark those contexts LINKED.
export const linksV3Routes = Router();

linksV3Routes.post('/context/on-notify', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const status = payload?.acknowledgement?.status;
  logger.info('V3 callback: links/context/on-notify received', {
    requestId: payload?.response?.requestId || payload?.resp?.requestId,
    status,
    error: payload?.error,
  });

  const careContexts = payload?.acknowledgement?.careContexts || payload?.careContexts;
  if (status === 'SUCCESS' && Array.isArray(careContexts) && careContexts.length) {
    for (const cc of careContexts) {
      const ref = cc?.referenceNumber || cc?.careContextReference;
      if (!ref) continue;
      try {
        await prisma.careContext.updateMany({
          where: { careContextId: ref },
          data: { linkStatus: 'LINKED' },
        });
      } catch (err: any) {
        logger.warn('links/context/on-notify: failed to update care context', { ref, error: err.message });
      }
    }
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

// ── Patient lifecycle (DEACTIVATED / DELETED / ACTIVE) ──────────────────────
// ABDM spec (ndhm-hip §/v0.5/patients/status/notify): the CM notifies the HIP
// when an ABHA holder deactivates or deletes their PHR. The HIP MUST stop using
// that ABHA — drop the local ABHA mapping, unlink care contexts so we cannot
// push to them, revoke any consents that referenced this patient, and ack the
// CM at /patients/v3/status/on-notify.
//
// Body shape: { notification: { abhaAddress, status: ACTIVE|DEACTIVATED|DELETED,
//                deactivationReason?, deactivationDate? }, requestId }
// V3 path: POST /api/v3/patients/status/notify
patientsV3Routes.post('/status/notify', verifyAbdmCallback, asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body || {};
  const notification = payload?.notification || {};
  const abhaAddress: string | undefined = notification.abhaAddress;
  const abhaNumber: string | undefined = notification.abhaNumber;
  const incomingStatus: string = notification.status || 'ACTIVE';
  const echoedRequestId = (req.headers['request-id'] as string) || payload?.requestId;

  logger.info('V3 callback: patients/status/notify received', {
    abhaAddress,
    abhaNumber,
    status: incomingStatus,
  });

  const validStatuses = new Set(['ACTIVE', 'DEACTIVATED', 'DELETED']);
  if (!validStatuses.has(incomingStatus)) {
    logger.warn('patients/status/notify: unknown status', { incomingStatus });
    res.status(202).json({ message: 'Acknowledged' });
    return;
  }

  try {
    // Find every Patient row that references this ABHA — across all hospitals
    // a single ABHA can be linked at multiple sites. Each must be cleaned up.
    const orPatient: any[] = [];
    if (abhaAddress) orPatient.push({ abhaAddress }, { abhaRecord: { abhaAddress } });
    if (abhaNumber) orPatient.push({ abhaNumber }, { abhaRecord: { abhaNumber } });
    if (!orPatient.length) {
      logger.warn('patients/status/notify: no ABHA identifier in payload');
      res.status(202).json({ message: 'Acknowledged' });
      return;
    }

    const patients = await prisma.patient.findMany({
      where: { OR: orPatient },
      select: { id: true, abhaNumber: true, abhaAddress: true, hospitalId: true },
    });

    const patientIds = patients.map(p => p.id);
    const summary = { patients: patients.length, careContexts: 0, consents: 0, abhaRecords: 0 };

    if (incomingStatus === 'ACTIVE') {
      // Re-activation: lift the soft block but DO NOT auto-relink contexts —
      // patient must re-trigger linking. Just clear the deactivation flag.
      const r = await prisma.abhaRecord.updateMany({
        where: { OR: [
          ...(abhaAddress ? [{ abhaAddress }] : []),
          ...(abhaNumber ? [{ abhaNumber }] : []),
        ] },
        data: { profileStatus: 'ACTIVE', deactivatedAt: null },
      });
      summary.abhaRecords = r.count;
    } else {
      // DEACTIVATED or DELETED → wipe linkages + revoke consents
      // 1. AbhaRecord: flag profileStatus and stamp deactivatedAt.
      const abhaUpdate = await prisma.abhaRecord.updateMany({
        where: { OR: [
          ...(abhaAddress ? [{ abhaAddress }] : []),
          ...(abhaNumber ? [{ abhaNumber }] : []),
        ] },
        data: {
          profileStatus: incomingStatus === 'DELETED' ? 'DELETED' : 'DEACTIVATED',
          deactivatedAt: new Date(),
        },
      });
      summary.abhaRecords = abhaUpdate.count;

      if (patientIds.length) {
        // 2. Unlink every care context for these patients — we must stop
        //    discovery/data-flow against deactivated PHRs.
        const ccUpdate = await prisma.careContext.updateMany({
          where: { patientId: { in: patientIds } },
          data: { linkStatus: 'UNLINKED', linkToken: null },
        });
        summary.careContexts = ccUpdate.count;

        // 3. Revoke any open consents involving this patient (HIP-side records
        //    of HIU-issued consents, plus the patient's own consent rows).
        const cnUpdate = await prisma.consent.updateMany({
          where: {
            patientId: { in: patientIds },
            status: { in: ['REQUESTED', 'GRANTED'] },
          },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
          },
        });
        summary.consents = cnUpdate.count;

        // 4. For DELETED — purge the cached ABHA address/number from each
        //    Patient row so it doesn't accidentally resurface in discovery.
        if (incomingStatus === 'DELETED') {
          await prisma.patient.updateMany({
            where: { id: { in: patientIds } },
            data: { abhaNumber: null, abhaAddress: null, abhaId: null },
          });
        }
      }
    }

    // 5. Audit log so this is visible in compliance dashboards.
    try {
      await prisma.auditLog.create({
        data: {
          action: `PATIENT_${incomingStatus}`,
          module: 'HIP',
          userType: 'SYSTEM',
          resourceType: 'PATIENT',
          status: 'SUCCESS',
          requestData: { abhaAddress, abhaNumber, summary } as any,
        },
      });
    } catch (e: any) {
      logger.warn('patients/status/notify: audit log write failed', { message: e?.message });
    }

    logger.info('patients/status/notify: applied lifecycle change', { incomingStatus, summary });
  } catch (err: any) {
    logger.error('patients/status/notify: processing failed', { error: err?.message });
  }

  // Ack the CM via the on-notify endpoint (best-effort).
  try {
    await abdmClient.post(
      abdmConfig.endpoints.hip.patientStatusOnNotify,
      {
        acknowledgement: { status: 'ok', abhaAddress, abhaNumber },
        response: { requestId: echoedRequestId },
      },
      { 'X-HIP-ID': abdmConfig.hip.id },
    );
  } catch (e: any) {
    logger.warn('patients/status/notify: on-notify ack failed', { message: e?.message });
  }

  res.status(202).json({ message: 'Patient lifecycle change processed' });
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
    abhaNumber,
    hasToken:   !!linkToken,
    error:      payload?.error,
  });

  if (!linkToken) {
    // Surface the ABDM error verbatim — this is the authoritative reason
    // generate-token produced no link token (e.g. invalid ABHA address,
    // PHR not found). Without it the failure is invisible and linking
    // silently stalls in PENDING.
    logger.warn('on-generate-token: no link token in payload — ABDM returned an error', {
      keys: Object.keys(payload || {}),
      abhaAddress,
      abhaNumber,
      error: payload?.error,
      response: payload?.response,
    });
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
        include: { encounter: true },
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

      // Group by derived hiType so the CM gets one block per type.
      const blocks = await hipService.groupCareContextsByHiType(contexts);

      await hipService.hipInitiatedLink({
        abhaNumber:  resolvedAbhaNumber,
        abhaAddress: resolvedAbhaAddress,
        linkToken,
        patient: blocks.map(b => ({
          referenceNumber: patientRef,
          display: patientName,
          careContexts: b.careContexts,
          hiType: b.hiType,
          count: b.count,
        })),
      });

      logger.info('on-generate-token: hipInitiatedLink submitted', {
        patientId: patient.id,
        count: contexts.length,
        hiTypeBreakdown: blocks.map(b => ({ hiType: b.hiType, count: b.count })),
      });
    } catch (e: any) {
      logger.warn('on-generate-token: hipInitiatedLink failed', { message: e?.message });
    }
  });

  res.status(202).json({ message: 'Token received, linking initiated' });
}));
