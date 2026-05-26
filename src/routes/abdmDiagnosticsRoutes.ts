import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../common/middleware/auth';
import { asyncHandler } from '../common/middleware/errorHandler';
import abdmClient from '../common/utils/abdm-client';
import { abdmConfig } from '../common/config/abdm';
import prisma from '../common/config/database';

const router = Router();

router.use(authenticate);
router.use(authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/bridge-services', asyncHandler(async (_req: Request, res: Response) => {
  const services = await abdmClient.getBridgeServices();
  res.json({ success: true, data: services });
}));

router.get('/bridge-service/:serviceId', asyncHandler(async (req: Request, res: Response) => {
  const services = await abdmClient.getBridgeServiceById(req.params.serviceId);
  res.json({ success: true, data: services });
}));

router.get('/config', asyncHandler(async (_req: Request, res: Response) => {
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

router.get('/transaction-stats', asyncHandler(async (_req: Request, res: Response) => {
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

export default router;
