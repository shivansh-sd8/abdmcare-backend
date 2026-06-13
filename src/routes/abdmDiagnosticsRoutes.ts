import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../common/middleware/auth';
import { asyncHandler } from '../common/middleware/errorHandler';
import abdmClient from '../common/utils/abdm-client';
import { abdmConfig } from '../common/config/abdm';
import prisma from '../common/config/database';

const router = Router();

router.use(authenticate);

// ABDM bridge config + per-hospital registration are admin-level
// (a hospital admin onboarding their own facility).
// Platform-global ABDM endpoints (transaction-stats, raw bridge service
// listing, raw config) are SUPER_ADMIN-only — they expose cross-hospital
// infrastructure traffic and platform credentials.
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;
const PLATFORM_ROLES = ['SUPER_ADMIN'] as const;

router.get('/bridge-services', authorize(...PLATFORM_ROLES), asyncHandler(async (_req: Request, res: Response) => {
  const services = await abdmClient.getBridgeServices();
  res.json({ success: true, data: services });
}));

router.get('/bridge-service/:serviceId', authorize(...ADMIN_ROLES), asyncHandler(async (req: Request, res: Response) => {
  const services = await abdmClient.getBridgeServiceById(req.params.serviceId);
  res.json({ success: true, data: services });
}));

router.get('/config', authorize(...ADMIN_ROLES), asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      gatewayUrl: abdmConfig.gatewayUrl,
      hipId: abdmConfig.hip.id,
      hipName: abdmConfig.hip.name,
      hiuId: abdmConfig.hiu.id,
      hiuName: abdmConfig.hiu.name,
      callbackUrl: abdmConfig.callbackUrl,
      cmId: abdmConfig.cmId,
    },
  });
}));

router.get('/transaction-stats', authorize(...PLATFORM_ROLES), asyncHandler(async (_req: Request, res: Response) => {
  // ABDM transactions are platform-wide infrastructure traffic — they aren't
  // tagged with a hospitalId, so the SUPER_ADMIN "viewing as" scope cannot
  // narrow them down. Always return the global counts.
  const [total, successful, failed] = await Promise.all([
    prisma.abdmTransaction.count(),
    prisma.abdmTransaction.count({ where: { success: true } }),
    prisma.abdmTransaction.count({ where: { success: false } }),
  ]);
  const recent = await prisma.abdmTransaction.findMany({
    orderBy: { timestamp: 'desc' },
    take: 20,
    select: { id: true, apiEndpoint: true, method: true, success: true, statusCode: true, timestamp: true },
  });
  res.json({ success: true, data: { total, successful, failed, recent } });
}));

/**
 * One-shot bridge setup for the current admin's hospital.
 *
 * Performs (idempotently):
 *   1. PATCH /gateway/v3/bridge/url   — point ABDM callbacks at our public URL
 *   2. POST  MutipleHRPAddUpdateServices for type=HIP and/or type=HIU
 *      (HFR may have already auto-registered these; "already associated"
 *       responses from ABDM are treated as a no-op success)
 *   3. UPDATE hospitals SET abdmEnabled, abdmRegisteredAt
 *
 * Body (all optional):
 *   {
 *     "register": ["HIP","HIU"],    // default: both
 *     "callbackUrl": "https://..."  // default: abdmConfig.callbackUrl
 *   }
 */
router.post('/register-services', authorize(...ADMIN_ROLES), asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const hospital = await prisma.hospital.findUnique({ where: { id: user.hospitalId } });
  if (!hospital) {
    return res.status(404).json({ success: false, message: 'Hospital not found' });
  }
  if (!hospital.hipId && !hospital.hiuId) {
    return res.status(400).json({
      success: false,
      message: 'Hospital has no hipId or hiuId configured. Register the facility in HFR first.',
    });
  }

  const register: string[] = Array.isArray(req.body?.register) && req.body.register.length
    ? req.body.register.map((t: string) => t.toUpperCase())
    : ['HIP', 'HIU'];
  const callbackUrl: string = req.body?.callbackUrl || abdmConfig.callbackUrl;

  const steps: Array<{ step: string; status: 'OK' | 'NOOP' | 'FAILED'; detail?: any }> = [];

  // ── Step 1: Update bridge URL ────────────────────────────────────────────
  try {
    await abdmClient.updateBridgeUrl(callbackUrl);
    steps.push({ step: `updateBridgeUrl(${callbackUrl})`, status: 'OK' });
  } catch (err: any) {
    steps.push({
      step: `updateBridgeUrl(${callbackUrl})`,
      status: 'FAILED',
      detail: err?.response?.data || err?.message,
    });
  }

  // ── Step 2: Register HIP / HIU services ──────────────────────────────────
  const facilityId = hospital.hipId || hospital.hiuId!;
  const facilityName = hospital.name;

  if (register.includes('HIP') && hospital.hipId) {
    try {
      await abdmClient.addBridgeHipService({
        facilityId: hospital.hipId,
        facilityName,
        bridgeId: abdmConfig.clientId,
        hipName: facilityName,
        active: true,
      });
      steps.push({ step: `addBridgeHipService(${hospital.hipId})`, status: 'OK' });
    } catch (err: any) {
      const detail = err?.response?.data || err?.message;
      const alreadyAssociated = JSON.stringify(detail).includes('already associated');
      steps.push({
        step: `addBridgeHipService(${hospital.hipId})`,
        status: alreadyAssociated ? 'NOOP' : 'FAILED',
        detail,
      });
    }
  }

  if (register.includes('HIU') && hospital.hiuId) {
    try {
      await abdmClient.addBridgeHiuService({
        facilityId: hospital.hiuId,
        facilityName,
        bridgeId: abdmConfig.clientId,
        hiuName: facilityName,
        active: true,
      });
      steps.push({ step: `addBridgeHiuService(${hospital.hiuId})`, status: 'OK' });
    } catch (err: any) {
      const detail = err?.response?.data || err?.message;
      const alreadyAssociated = JSON.stringify(detail).includes('already associated');
      steps.push({
        step: `addBridgeHiuService(${hospital.hiuId})`,
        status: alreadyAssociated ? 'NOOP' : 'FAILED',
        detail,
      });
    }
  }

  // ── Step 3: Mark hospital ABDM-enabled if everything is OK/NOOP ──────────
  const anyFailed = steps.some(s => s.status === 'FAILED');
  if (!anyFailed) {
    await prisma.hospital.update({
      where: { id: hospital.id },
      data: { abdmEnabled: true, abdmRegisteredAt: new Date() },
    });
  }

  // ── Step 4: Return verified bridge-services snapshot ─────────────────────
  let bridgeServices: any = null;
  try {
    bridgeServices = await abdmClient.getBridgeServiceById(facilityId);
  } catch (err: any) {
    bridgeServices = { error: err?.response?.data || err?.message };
  }

  return res.json({
    success: !anyFailed,
    data: {
      hospital: { id: hospital.id, name: hospital.name, hipId: hospital.hipId, hiuId: hospital.hiuId },
      bridgeId: abdmConfig.clientId,
      callbackUrl,
      steps,
      bridgeServices,
    },
  });
}));

export default router;
