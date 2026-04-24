import { Router } from 'express';
import vitalsController from '../controllers/vitalsController';
import { body, query } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';

const router = Router();

router.use(authenticate);

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
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  vitalsController.getLatestVitals
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  vitalsController.getVitalsById
);

router.put(
  '/:id',
  authorize('DOCTOR', 'NURSE'),
  vitalsController.updateVitals
);

router.delete(
  '/:id',
  authorize('DOCTOR', 'SUPER_ADMIN'),
  vitalsController.deleteVitals
);

export default router;
