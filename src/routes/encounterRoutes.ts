import { Router } from 'express';
import encounterController from '../controllers/encounterController';
import { body, query } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  authorize('DOCTOR', 'ADMIN'),
  [
    body('patientId').notEmpty().withMessage('Patient ID is required'),
    body('doctorId').notEmpty().withMessage('Doctor ID is required'),
    body('type').isIn(['OPD', 'IPD', 'EMERGENCY']).withMessage('Valid encounter type is required'),
    body('chiefComplaint').notEmpty().withMessage('Chief complaint is required'),
  ],
  validate,
  encounterController.createEncounter
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  encounterController.getEncounterStats
);

router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  encounterController.getAllEncounters
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  encounterController.getEncounterById
);

router.put(
  '/:id',
  authorize('DOCTOR', 'ADMIN'),
  encounterController.updateEncounter
);

router.post(
  '/:id/complete',
  authorize('DOCTOR'),
  [
    body('diagnosis').notEmpty().withMessage('Diagnosis is required'),
  ],
  validate,
  encounterController.completeEncounter
);

export default router;
