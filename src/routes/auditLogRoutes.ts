import { Router } from 'express';
import auditLogController from '../controllers/auditLogController';
import { authenticate, authorize } from '../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN'),
  auditLogController.getAuditLogs
);

router.get(
  '/user/:userId',
  authorize('SUPER_ADMIN', 'ADMIN'),
  auditLogController.getUserActivity
);

router.get(
  '/entity/:entity/:entityId',
  authorize('SUPER_ADMIN', 'ADMIN'),
  auditLogController.getEntityHistory
);

export default router;
