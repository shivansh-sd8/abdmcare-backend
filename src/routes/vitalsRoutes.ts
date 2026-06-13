import { Router } from 'express';
import vitalsController from '../controllers/vitalsController';
import { body, query } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';
import { auditLog } from '../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('VITALS'));

router.post(
  '/',
  authorize('DOCTOR', 'NURSE'),
  [
    body('patientId').notEmpty().withMessage('Patient ID is required'),
  ],
  validate,
  vitalsController.createVitals
);

router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  vitalsController.getAllVitals
);

router.get(
  '/patient/:patientId/latest',
  // Pharmacist needs the latest vitals (allergies / age / weight) for
  // safe dispensing decisions — read-only, hospital-scoped in service.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'PHARMACIST'),
  vitalsController.getLatestVitals
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  vitalsController.getVitalsById
);

router.put(
  '/:id',
  // Admins must be able to correct mistakenly-recorded vitals (wrong
  // patient, fat-fingered values) — clinical staff still own the
  // primary write path.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  vitalsController.updateVitals
);

router.delete(
  '/:id',
  // ADMIN added so a hospital admin can purge a clearly bogus reading
  // without escalating to the platform SUPER_ADMIN.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  vitalsController.deleteVitals
);

export default router;
