import { Router } from 'express';
import hiuController from './hiu.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { verifyAbdmCallback } from '../../common/middleware/verifyAbdmCallback';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ABDM V3 CALLBACKS (verified via ABDM JWT from /v3/certs JWKS)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/data/notification', verifyAbdmCallback, hiuController.receiveHealthInformation);

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL APIs (auth required)
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);
router.use(auditLog('HIU'));

router.post(
  '/request',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  [
    body('consentId').notEmpty().withMessage('Consent ID is required'),
    // dateRange is OPTIONAL — when not supplied, the service falls back to
    // the consent's granted dateRange. This enables the UI's one-click pull
    // (the user already picked dates when requesting consent, no reason to
    // ask again).
    body('dateRangeFrom').optional().isISO8601().withMessage('Valid from date required'),
    body('dateRangeTo').optional().isISO8601().withMessage('Valid to date required'),
  ],
  validate,
  hiuController.requestHealthInformation
);

router.get(
  '/patient/:patientId/records',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  hiuController.getPatientHealthRecords
);

export default router;
