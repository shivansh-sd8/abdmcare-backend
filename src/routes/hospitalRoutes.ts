import { Router } from 'express';
import hospitalController from '../controllers/hospitalController';
import { body } from 'express-validator';
import { validate } from '../common/middleware/validation';
import { authenticate, authorize } from '../common/middleware/auth';
import { auditLog } from '../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('HOSPITAL'));

// Create hospital - SUPER_ADMIN only
router.post(
  '/',
  authorize('SUPER_ADMIN'),
  [
    body('name').notEmpty().withMessage('Hospital name is required'),
    body('code').notEmpty().withMessage('Hospital code is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
  ],
  validate,
  hospitalController.createHospital
);

// Get all hospitals - SUPER_ADMIN only
router.get(
  '/',
  authorize('SUPER_ADMIN'),
  hospitalController.getAllHospitals
);

// Get hospital by ID - SUPER_ADMIN and ADMIN (own hospital)
router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN'),
  hospitalController.getHospitalById
);

// Update hospital - SUPER_ADMIN only
router.put(
  '/:id',
  authorize('SUPER_ADMIN'),
  hospitalController.updateHospital
);

// Delete hospital - SUPER_ADMIN only
router.delete(
  '/:id',
  authorize('SUPER_ADMIN'),
  hospitalController.deleteHospital
);

// Get hospital stats - SUPER_ADMIN and ADMIN (own hospital)
router.get(
  '/:id/stats',
  authorize('SUPER_ADMIN', 'ADMIN'),
  hospitalController.getHospitalStats
);

export default router;
