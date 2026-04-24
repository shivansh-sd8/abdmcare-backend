import { Router } from 'express';
import prescriptionController from '../controllers/prescriptionController';
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
    body('doctorId').notEmpty().withMessage('Doctor ID is required'),
    body('medications').isArray({ min: 1 }).withMessage('At least one medication is required'),
  ],
  validate,
  prescriptionController.createPrescription
);

router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'PHARMACIST'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  prescriptionController.getAllPrescriptions
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'PHARMACIST'),
  prescriptionController.getPrescriptionById
);

router.put(
  '/:id',
  authorize('DOCTOR'),
  prescriptionController.updatePrescription
);

router.delete(
  '/:id',
  authorize('DOCTOR', 'SUPER_ADMIN'),
  prescriptionController.deletePrescription
);

export default router;
