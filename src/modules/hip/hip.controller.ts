import { Request, Response, NextFunction } from 'express';
import { HipService } from './hip.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler, AppError } from '../../common/middleware/errorHandler';
import abdmClient from '../../common/utils/abdm-client';
import { abdmConfig } from '../../common/config/abdm';
import logger from '../../common/config/logger';
import prisma from '../../common/config/database';

export class HipController {
  private hipService: HipService;

  constructor() {
    this.hipService = new HipService();
  }

  // ── Scan & Share callback (ABDM → HIP) ────────────────────────────────────
  handleProfileShare = asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json({ message: 'Profile share received' });
    const payload = req.body;
    logger.info('Scan & Share received', { hipId: payload?.metaData?.hipId });
    setImmediate(async () => {
      try {
        const profile = payload?.profile?.patient || payload?.profile || {};
        const abhaNumber = profile?.abhaNumber || profile?.ABHANumber || '';
        const abhaAddr = profile?.abhaAddress || profile?.preferredAbhaAddress || '';
        const tokenNumber = `TKN-${Date.now()}`;

        // Persist or update patient from Scan & Share
        if (abhaNumber) {
          const normalized = abhaNumber.replace(/-/g, '');
          const existingPatient = await this.hipService.findPatientByAbha(normalized);
          if (!existingPatient) {
            await this.hipService.createPatientFromScanShare(profile, normalized, abhaAddr);
            logger.info('Scan & Share: new patient created', { abhaNumber: normalized });
          } else {
            logger.info('Scan & Share: returning patient found', { abhaNumber: normalized, patientId: existingPatient.id });
          }
        }

        // Send on-share acknowledgement to ABDM.
        //
        // Wire format per the M3 Scan & Share Postman (`02 profile-on-share`):
        //   {
        //     acknowledgement: {
        //       status: "SUCCESS",
        //       abhaAddress, profile: { context, tokenNumber, expiry }
        //     },
        //     response: { requestId }
        //   }
        //
        // Critical gotchas (both confirmed by ABDM-9999 errors in prod):
        //   • `expiry` MUST be a string of digits — seconds, NOT an ISO date.
        //     ABDM rejects with "Invalid expiry, it must contain only 0-9".
        //   • The correlation envelope key is `response` (not `resp`). Sending
        //     `resp` makes ABDM see `response = null` and reject with
        //     "Response cannot be NULL".
        // Token validity = 30 min = 1800 seconds.
        await abdmClient.post(abdmConfig.endpoints.scanAndShare.onShare, {
          acknowledgement: {
            status: 'SUCCESS',
            abhaAddress: abhaAddr,
            profile: {
              context: payload?.metaData?.context || '',
              tokenNumber,
              expiry: '1800',
            },
          },
          response: { requestId: payload?.requestId || '' },
        });
        // Persist received share event for frontend polling
        await this.hipService.saveReceivedShare({
          abhaNumber: abhaNumber.replace(/-/g, ''),
          abhaAddress: abhaAddr,
          name: profile?.name || `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim(),
          gender: profile?.gender || '',
          mobile: profile?.mobile || profile?.phoneNumber || '',
          tokenNumber,
          requestId: payload?.requestId || '',
          rawProfile: profile,
        });

        logger.info('Scan & Share: on-share acknowledged', { tokenNumber });
      } catch (err) { logger.error('on-share acknowledgement failed', err); }
    });
  });

  // ── M2: HIP Initiated Linking ──────────────────────────────────────────────
  generateLinkToken = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.generateLinkToken(req.body);
    ResponseHandler.success(res, 'Link token generated', result);
  });

  hipInitiatedLink = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.hipInitiatedLink(req.body);
    ResponseHandler.success(res, 'Care context linked', result);
  });

  linkContextNotify = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.linkContextNotify(req.body);
    ResponseHandler.success(res, 'Link notification sent', result);
  });

  smsNotify = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const { phoneNo, hipName, hipId } = req.body;

    let resolvedHipId = hipId || abdmConfig.hip.id;
    let resolvedHipName = hipName || abdmConfig.hip.name;

    if (currentUser?.hospitalId) {
      const hospital = await prisma.hospital.findUnique({
        where: { id: currentUser.hospitalId },
        select: { hipId: true, name: true },
      });
      if (hospital?.hipId) {
        resolvedHipId = hospital.hipId;
        resolvedHipName = hospital.name;
      }
    }

    const result = await this.hipService.smsNotify(phoneNo, resolvedHipName, resolvedHipId);
    ResponseHandler.success(res, 'SMS notification sent', result);
  });

  // ── M2: User Initiated Linking (ABDM callbacks) ────────────────────────────
  // ABDM sends the message id in the `REQUEST-ID` HTTP header (NOT the body —
  // the discover body is only { transactionId, patient }). Every on-* response
  // must echo it as `response.requestId`, so we merge the header in here. Falling
  // back to the body keeps it robust if ABDM ever includes it there.
  discoverCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const requestId = (req.headers['request-id'] as string) || req.body?.requestId;
    const result = await this.hipService.discoverCareContexts({ ...req.body, requestId });
    res.status(202).json(result);
  });

  linkCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const requestId = (req.headers['request-id'] as string) || req.body?.requestId;
    const result = await this.hipService.linkCareContexts({ ...req.body, requestId });
    res.status(202).json(result);
  });

  confirmLinkCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const requestId = (req.headers['request-id'] as string) || req.body?.requestId;
    const result = await this.hipService.confirmLinkCareContexts({ ...req.body, requestId });
    res.status(202).json(result);
  });

  // ── M2: Data Transfer (ABDM callbacks) ─────────────────────────────────────
  handleConsentHipNotify = asyncHandler(async (req: Request, res: Response) => {
    // ABDM → HIP consent notification is NESTED: the consent id lives under
    // notification.consentDetail.consentId (or notification.consentId) and the
    // grant status under notification.status. Older code read these flat, so a
    // live grant was acknowledged with undefined ids. Parse defensively to
    // support both shapes.
    const body = req.body || {};
    const notification = body.notification || {};
    const consentDetail = notification.consentDetail || {};
    // REQUEST-ID is an HTTP header; the notify body is only { notification }.
    const requestId = (req.headers['request-id'] as string) || body.requestId || body.response?.requestId;
    const consentId = notification.consentId || consentDetail.consentId || body.consentId;
    const status = notification.status || body.status;
    await this.hipService.handleConsentHipNotify({ requestId, consentId, status });
    res.status(202).json({ message: 'Acknowledged' });
  });

  handleHealthInformationRequest = asyncHandler(async (req: Request, res: Response) => {
    // REQUEST-ID is an HTTP header (the body is only { transactionId, hiRequest }).
    // The on-request ACK must echo it as response.requestId, else ABDM rejects with
    // 400 "ABDM-1015: Invalid Response". The data-push notify also reuses it.
    const requestId = (req.headers['request-id'] as string) || req.body?.requestId;
    const result = await this.hipService.handleHealthInformationRequest({ ...req.body, requestId });
    res.status(202).json(result);
  });

  // ── M1: HFR / HIP Registration ──────────────────────────────────────────
  // SUPER_ADMIN may register any hospital by supplying { hospitalId } in body
  // or ?hospitalId=. Hospital ADMIN is locked to their own hospital.
  registerHipService = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const target =
      currentUser?.role === 'SUPER_ADMIN'
        ? (req.body?.hospitalId as string) || (req.query?.hospitalId as string) || currentUser.hospitalId
        : currentUser.hospitalId;
    if (!target) {
      throw new AppError('hospitalId is required', 400);
    }
    const result = await this.hipService.registerHipService(target);
    ResponseHandler.success(res, 'HIP service registered with ABDM', result);
  });

  // ── M1: HIU Registration (mirrors HIP for HIU-side bridge) ──────────────
  registerHiuService = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const target =
      currentUser?.role === 'SUPER_ADMIN'
        ? (req.body?.hospitalId as string) || (req.query?.hospitalId as string) || currentUser.hospitalId
        : currentUser.hospitalId;
    if (!target) {
      throw new AppError('hospitalId is required', 400);
    }
    const result = await this.hipService.registerHiuService(target);
    ResponseHandler.success(res, 'HIU service registered with ABDM', result);
  });

  // ── M1: Facility QR & Received Shares ──────────────────────────────────────
  //
  // ABDM spec requires the QR payload to be a *URL* (not JSON). Format:
  //   {scanShareBase}/share-profile?hip-id={HFR_ID}&counter-id={CTR}
  //
  // Identifiers come strictly from the database (per-hospital). There is NO
  // env fallback — a hospital that hasn't been registered with HFR cannot
  // generate a working facility QR, and we want that failure to surface
  // clearly rather than silently succeed with a stale single-tenant value.
  getFacilityQrData = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;

    // SUPER_ADMIN may pass ?hospitalId=... to inspect a specific tenant; for
    // every other role we lock to their own hospital.
    const targetHospitalId =
      currentUser?.role === 'SUPER_ADMIN'
        ? ((req.query?.hospitalId as string) || currentUser?.hospitalId)
        : currentUser?.hospitalId;

    if (!targetHospitalId) {
      throw new AppError('Hospital context missing on this account', 400);
    }

    const hospital = await prisma.hospital.findUnique({
      where: { id: targetHospitalId },
      select: {
        id: true,
        name: true,
        hipId: true,
        hiuId: true,
        hfrFacilityId: true,
        abdmEnabled: true,
        abdmRegisteredAt: true,
      },
    });

    if (!hospital) {
      throw new AppError('Hospital not found', 404);
    }

    // The QR uses the HFR Facility ID. When deployments only set hipId we
    // accept that as a synonym (HFR id and HIP id are typically equal).
    const facilityId = hospital.hfrFacilityId || hospital.hipId;
    if (!facilityId) {
      throw new AppError(
        'This hospital is not registered with HFR yet. Add an HFR Facility ID (or HIP ID) to enable the facility QR.',
        409,
      );
    }

    // Counter id identifies the physical scanning station. We expose a stable
    // short identifier per hospital (so all stations of the same facility map
    // back consistently in callbacks). Facilities can override this later.
    const counterId = (hospital.id || '').slice(0, 8) || 'main';

    const shareProfileUrl = `${abdmConfig.scanShareBaseUrl}/share-profile?hip-id=${encodeURIComponent(facilityId)}&counter-id=${encodeURIComponent(counterId)}`;

    ResponseHandler.success(res, 'Facility QR data', {
      hipId: hospital.hipId || facilityId,
      hipName: hospital.name,
      hfrFacilityId: hospital.hfrFacilityId || null,
      hiuId: hospital.hiuId || null,
      abdmEnabled: hospital.abdmEnabled,
      abdmRegisteredAt: hospital.abdmRegisteredAt,
      counterId,
      // The string the QR encodes — clients should render this verbatim.
      shareProfileUrl,
      // Backwards-compat alias used by older clients; same value.
      scanAndShareUrl: shareProfileUrl,
    });
  });

  getReceivedShares = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const shares = await this.hipService.getReceivedShares(currentUser?.hospitalId);
    ResponseHandler.success(res, 'Received profile shares', shares);
  });

  // ── Internal APIs ──────────────────────────────────────────────────────────
  addCareContexts = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { patientId } = req.params;
    const { careContexts } = req.body;
    const result = await this.hipService.addCareContexts(patientId, careContexts);
    ResponseHandler.success(res, result.message, result.data, 201);
  });

  getCareContexts = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { patientId } = req.params;
    const contexts = await prisma.careContext.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });
    ResponseHandler.success(res, 'Care contexts retrieved', contexts);
  });
}

export default new HipController();
