import { Request, Response, NextFunction } from 'express';
import { HipService } from './hip.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';
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

        // Send on-share acknowledgement (absolute URL)
        await abdmClient.post(abdmConfig.endpoints.scanAndShare.onShare, {
          acknowledgement: {
            status: 'SUCCESS',
            abhaAddress: abhaAddr,
            profile: {
              context: payload?.metaData?.context || '',
              tokenNumber,
              expiry: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            },
          },
          error: null,
          resp: { requestId: payload?.requestId || '' },
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
  discoverCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.discoverCareContexts(req.body);
    res.status(202).json(result);
  });

  linkCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.linkCareContexts(req.body);
    res.status(202).json(result);
  });

  confirmLinkCareContexts = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.confirmLinkCareContexts(req.body);
    res.status(202).json(result);
  });

  // ── M2: Data Transfer (ABDM callbacks) ─────────────────────────────────────
  handleConsentHipNotify = asyncHandler(async (req: Request, res: Response) => {
    const { requestId, consentId, status } = req.body;
    await this.hipService.handleConsentHipNotify({ requestId, consentId, status });
    res.status(202).json({ message: 'Acknowledged' });
  });

  handleHealthInformationRequest = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.hipService.handleHealthInformationRequest(req.body);
    res.status(202).json(result);
  });

  // ── M1: HFR / HIP Registration ──────────────────────────────────────────
  registerHipService = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    const result = await this.hipService.registerHipService(currentUser.hospitalId);
    ResponseHandler.success(res, 'HIP service registered with ABDM', result);
  });

  // ── M1: Facility QR & Received Shares ──────────────────────────────────────
  getFacilityQrData = asyncHandler(async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    let hipId = abdmConfig.hip.id;
    let hipName = abdmConfig.hip.name;

    if (currentUser?.hospitalId) {
      const hospital = await prisma.hospital.findUnique({
        where: { id: currentUser.hospitalId },
        select: { hipId: true, name: true },
      });
      if (hospital?.hipId) {
        hipId = hospital.hipId;
        hipName = hospital.name;
      }
    }

    const data = {
      hipId,
      hipName,
      callbackUrl: abdmConfig.callbackUrl,
      scanAndShareUrl: `${abdmConfig.callbackUrl}/api/v3/hip/patient/share`,
      counter: Date.now().toString(36),
    };
    ResponseHandler.success(res, 'Facility QR data', data);
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
