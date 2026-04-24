import { Router } from 'express';
import abhaController from './abha.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { loginLimiter } from '../../common/middleware/rateLimiter';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/generate-aadhaar-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  loginLimiter,
  [body('aadhaar').isLength({ min: 12, max: 12 }).withMessage('Valid 12-digit Aadhaar is required')],
  validate,
  abhaController.generateAadhaarOtp
);

router.post(
  '/verify-aadhaar-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('Transaction ID is required'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('Valid 6-digit OTP is required'),
  ],
  validate,
  abhaController.verifyAadhaarOtp
);

router.post(
  '/create',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('Transaction ID is required'),
    body('mobile').optional().isMobilePhone('en-IN').withMessage('Valid mobile number is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
  ],
  validate,
  abhaController.createAbha
);

router.get('/profile/:abhaId', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), abhaController.getProfile);

router.get('/qr-code/:abhaId', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), abhaController.getQrCode);

router.post('/search', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), abhaController.searchAbha);

router.post(
  '/link-patient',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('abhaNumber').notEmpty().withMessage('ABHA number is required'),
    body('patientId').notEmpty().withMessage('Patient ID is required'),
  ],
  validate,
  abhaController.linkToPatient
);

export default router;
