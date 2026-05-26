import { Router } from 'express';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';
import {
  generateDocument,
  getDocument,
  downloadDocument,
  listDocuments,
  getDocumentStats,
  publicDownload,
} from './document.controller';

const router = Router();

// Public download via time-limited token (no auth required)
router.get('/public/:token', publicDownload);

// All other routes require authentication
router.use(authenticate);
router.use(auditLog('DOCUMENT'));

router.post('/generate',  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), generateDocument);
router.get('/stats',       authorize('SUPER_ADMIN', 'ADMIN'), getDocumentStats);
router.get('/:id',         getDocument);
router.get('/:id/download', downloadDocument);
router.get('/',            listDocuments);

export default router;
