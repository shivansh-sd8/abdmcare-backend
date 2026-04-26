import { Router } from 'express';
import paymentController from '../controllers/paymentController';
import { authenticate, authorize } from '../common/middleware/auth';
import { auditLog } from '../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('PAYMENT'));

// Get payment stats - ADMIN, SUPER_ADMIN (must be before /:id)
router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN'),
  paymentController.getPaymentStats
);

// Create payment - RECEPTIONIST, ADMIN, SUPER_ADMIN
router.post(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  paymentController.createPayment
);

// Get all payments - RECEPTIONIST, ADMIN, SUPER_ADMIN
router.get(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  paymentController.getAllPayments
);

// Get payment by ID
router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  paymentController.getPaymentById
);

// Update payment - RECEPTIONIST, ADMIN, SUPER_ADMIN
router.put(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  paymentController.updatePayment
);

// Mark as paid - RECEPTIONIST, ADMIN, SUPER_ADMIN
router.post(
  '/:id/mark-paid',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  paymentController.markAsPaid
);

export default router;
