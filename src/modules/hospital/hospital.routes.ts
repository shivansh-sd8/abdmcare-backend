import { Router } from 'express';
import hospitalController from './hospital.controller';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// All hospital routes require SUPER_ADMIN access
router.post(
  '/',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.onboardHospital
);

router.get(
  '/',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.getAllHospitals
);

router.get(
  '/stats',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.getHospitalStats
);

router.get(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  hospitalController.getHospitalById
);

router.put(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.updateHospital
);

router.put(
  '/:id/plan',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.updateHospitalPlan
);

router.delete(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.deleteHospital
);

export default router;
