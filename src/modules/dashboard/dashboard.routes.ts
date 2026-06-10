import { Router } from 'express';
import dashboardController from './dashboard.controller';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// All dashboard endpoints are authenticated and hospital-scoped via the
// scope helpers in each service method. We don't restrict by role beyond
// "must be logged in" — each endpoint is safe for any authenticated user
// because the hospital scope is enforced by the JWT (or the SUPER_ADMIN
// "viewing as" scope), not by trust in the caller.
router.use(authenticate);

router.get(
  '/trends',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  dashboardController.getDailyTrends,
);

router.get(
  '/hourly-load',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  dashboardController.getTodayHourlyLoad,
);

router.get(
  '/revenue-sources',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  dashboardController.getRevenueBySource,
);

router.get(
  '/top-doctors',
  authorize('SUPER_ADMIN', 'ADMIN'),
  dashboardController.getTopDoctors,
);

router.get(
  '/encounter-status',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'),
  dashboardController.getEncounterStatus,
);

export default router;
