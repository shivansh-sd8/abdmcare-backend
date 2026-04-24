import { Router } from 'express';
import investigationController from '../controllers/investigationController';
import { body, query } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  authorize('DOCTOR'),
  [
    body('patientId').notEmpty().withMessage('Patient ID is required'),
    body('testName').notEmpty().withMessage('Test name is required'),
    body('testType').notEmpty().withMessage('Test type is required'),
  ],
  validate,
  investigationController.createInvestigation
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'LAB_TECHNICIAN'),
  investigationController.getInvestigationStats
);

router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'LAB_TECHNICIAN'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  investigationController.getAllInvestigations
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'LAB_TECHNICIAN'),
  investigationController.getInvestigationById
);

router.put(
  '/:id/status',
  authorize('DOCTOR', 'LAB_TECHNICIAN'),
  [
    body('status').isIn(['ORDERED', 'SAMPLE_COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).withMessage('Valid status is required'),
  ],
  validate,
  investigationController.updateInvestigationStatus
);

export default router;
