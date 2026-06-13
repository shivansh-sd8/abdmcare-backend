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
  // Operational consult/appointment volume — relevant to clinical staff
  // and admins. Pharmacy and Lab have their own role-specific dashboards
  // (pharmacy stock, lab queues), so they're not on this trend chart.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
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

// Staff-wise collection breakdown — visible to admins (who own the
// reconciliation question) and to the receptionist responsible for cash,
// so they can self-check at the end of a shift.
router.get(
  '/staff-collections',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  dashboardController.getStaffCollections,
);

// Distinct list of users who have actually collected money — feeds the
// "Collected by" filter on the Billing dashboard. Same audience as the
// breakdown above.
router.get(
  '/payment-collectors',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  dashboardController.listPaymentCollectors,
);

export default router;
