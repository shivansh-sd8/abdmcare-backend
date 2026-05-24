import { Router } from 'express';
import hiuController from './hiu.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ABDM V3 CALLBACKS (no local auth — ABDM calls these)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/data/notification', hiuController.receiveHealthInformation);

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL APIs (auth required)
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

router.post(
  '/request',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  [
    body('consentId').notEmpty().withMessage('Consent ID is required'),
    body('dateRangeFrom').isISO8601().withMessage('Valid from date required'),
    body('dateRangeTo').isISO8601().withMessage('Valid to date required'),
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
