import { Router } from 'express';
import encounterController from './encounter.controller';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

router.use(auditLog('ENCOUNTER'));

// Get all encounters (with query params)
router.get(
  '/',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  encounterController.getDoctorEncounters
);

// Get a specific doctor's roster of encounters. RECEPTIONIST is excluded
// here — they have their own appointment + payment views; browsing a
// clinician's full clinical roster isn't part of the front-desk workflow.
router.get(
  '/doctor/:doctorId',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  encounterController.getDoctorEncounters
);

// Get full encounter snapshot (encounter + vitals + labs + Rx + payments + hospital)
// NOTE: RECEPTIONIST is intentionally excluded — they should only see the
// non-clinical encounter summary used for billing/check-in. Full clinical
// snapshots are restricted to clinicians and admins.
router.get(
  '/:id/full',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'),
  encounterController.getEncounterFull
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

// Collect OPD payment
router.patch(
  '/:id/collect-payment',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  encounterController.collectPayment
);

// Apply discount (admin-only)
router.patch(
  '/:id/discount',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  encounterController.applyDiscount
);

export default router;
