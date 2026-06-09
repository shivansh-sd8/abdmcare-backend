import { Router } from 'express';
import immunizationController from '../controllers/immunizationController';
import { body } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';
import { auditLog } from '../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('IMMUNIZATION'));

router.post(
  '/',
  authorize('DOCTOR', 'NURSE', 'ADMIN', 'SUPER_ADMIN'),
  [
    body('patientId').notEmpty().withMessage('patientId is required'),
    body('vaccineName').notEmpty().withMessage('vaccineName is required'),
    body('administeredAt').isISO8601().withMessage('administeredAt must be ISO8601'),
  ],
  validate,
  immunizationController.create,
);

router.get(
  '/patient/:patientId',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  immunizationController.listForPatient,
);

router.delete(
  '/:id',
  authorize('SUPER_ADMIN', 'DOCTOR'),
  immunizationController.delete,
);

export default router;
