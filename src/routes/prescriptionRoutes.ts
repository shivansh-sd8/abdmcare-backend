import { Router } from 'express';
import prescriptionController from '../controllers/prescriptionController';
import { body, query } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';
import { auditLog } from '../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('PRESCRIPTION'));

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
  // ADMIN can delete an erroneously-issued prescription on the doctor's
  // behalf without escalating to the platform SUPER_ADMIN.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  prescriptionController.deletePrescription
);

router.patch(
  '/:id/dispense',
  authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'),
  [body('medicines').isArray({ min: 1 }).withMessage('Medicines list is required')],
  validate,
  prescriptionController.dispensePrescription
);

export default router;
