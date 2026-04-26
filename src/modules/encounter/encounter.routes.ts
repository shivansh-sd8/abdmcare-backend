import { Router } from 'express';
import encounterController from './encounter.controller';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// Get all encounters (with query params)
router.get(
  '/',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  encounterController.getDoctorEncounters
);

// Get doctor's encounters
router.get(
  '/doctor/:doctorId',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  encounterController.getDoctorEncounters
);

// Get encounter by ID
router.get(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  encounterController.getEncounterById
);

// Update consultation
router.put(
  '/:id/consultation',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  encounterController.updateConsultation
);

// Complete consultation
router.post(
  '/:id/complete',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  encounterController.completeConsultation
);

export default router;
