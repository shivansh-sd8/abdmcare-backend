import { Router } from 'express';
import { body, query } from 'express-validator';
import abhaController from './abha.controller';
import { authenticate, authorize } from '../../common/middleware/auth';
import { validate } from '../../common/middleware/validation';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Health check (no auth required — for diagnosing ABDM connectivity)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/health', abhaController.healthCheck);

// ─────────────────────────────────────────────────────────────────────────────
// All other routes require authentication
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT — Aadhaar OTP
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/enrollment/aadhaar/send-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('aadhaar').notEmpty().withMessage('aadhaar is required')],
  validate,
  abhaController.generateAadhaarOtp
);

router.post(
  '/enrollment/aadhaar/resend-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('aadhaar').notEmpty().withMessage('aadhaar is required'),
  ],
  validate,
  abhaController.resendAadhaarOtp
);

router.post(
  '/enrollment/aadhaar/enrol',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('otp').notEmpty().withMessage('otp is required'),
  ],
  validate,
  abhaController.enrolByAadhaar
);

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT — Mobile verification (after Aadhaar enrol with different mobile)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/enrollment/mobile/send-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty(),
    body('mobile').isMobilePhone('en-IN').withMessage('Valid Indian mobile required'),
  ],
  validate,
  abhaController.sendMobileVerifyOtp
);

router.post(
  '/enrollment/mobile/verify-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('txnId').notEmpty(), body('otp').notEmpty()],
  validate,
  abhaController.verifyMobileOtp
);

// ─────────────────────────────────────────────────────────────────────────────
// ABHA ADDRESS
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/enrollment/abha-address/suggestions',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [query('txnId').notEmpty().withMessage('txnId is required')],
  validate,
  abhaController.getAbhaAddressSuggestions
);

router.post(
  '/enrollment/abha-address',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty(),
    body('abhaAddress').notEmpty().withMessage('abhaAddress is required'),
  ],
  validate,
  abhaController.createAbhaAddress
);

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT — Driving License
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/enrollment/dl/send-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('mobile').isMobilePhone('en-IN')],
  validate,
  abhaController.dlSendMobileOtp
);

router.post(
  '/enrollment/dl/verify-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('txnId').notEmpty(), body('otp').notEmpty()],
  validate,
  abhaController.dlVerifyMobileOtp
);

router.post(
  '/enrollment/dl/enrol',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty(),
    body('dlNumber').notEmpty(),
    body('firstName').notEmpty(),
    body('lastName').notEmpty(),
    body('dob').notEmpty(),
    body('gender').notEmpty(),
  ],
  validate,
  abhaController.enrolByDrivingLicense
);

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN / VERIFICATION (generic — used for ABHA number, mobile, Aadhaar login)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/login/request-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('scope').isArray().notEmpty(),
    body('loginHint').notEmpty(),
    body('loginId').notEmpty(),
    body('otpSystem').notEmpty(),
  ],
  validate,
  abhaController.loginRequestOtp
);

router.post(
  '/login/verify-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('scope').isArray().notEmpty(), body('txnId').notEmpty(), body('otp').notEmpty()],
  validate,
  abhaController.loginVerify
);

router.post(
  '/login/verify-password',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('scope').isArray(), body('abhaNumber').notEmpty(), body('password').notEmpty()],
  validate,
  abhaController.loginVerifyPassword
);

router.post(
  '/login/verify-user',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty(), body('txnId').notEmpty()],
  validate,
  abhaController.loginVerifyUser
);

router.post(
  '/login/search',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty()],
  validate,
  abhaController.loginSearch
);

// ─────────────────────────────────────────────────────────────────────────────
// FIND ABHA
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/find',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('mobile').isMobilePhone('en-IN')],
  validate,
  abhaController.findAbhaByMobile
);

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE (requires X-token from login)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/profile', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.getProfile);

router.patch(
  '/profile',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.updateProfile
);

router.get('/profile/qr', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.getQrCode);

router.get('/profile/card', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.getAbhaCard);

router.get('/profile/logout', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.logout);

// ── Profile OTP operations ─────────────────────────────────────────────────

router.post(
  '/profile/request-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('scope').isArray().notEmpty(), body('loginHint').notEmpty(), body('loginId').notEmpty(), body('otpSystem').notEmpty()],
  validate,
  abhaController.profileRequestOtp
);

router.post(
  '/profile/verify-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('scope').isArray().notEmpty(), body('txnId').notEmpty(), body('otp').notEmpty()],
  validate,
  abhaController.profileVerifyOtp
);

// ─────────────────────────────────────────────────────────────────────────────
// PHR / ABHA Address Verification (Scan & Share)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/phr/search',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaAddress').notEmpty()],
  validate,
  abhaController.phrSearch
);

router.post(
  '/phr/request-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaAddress').notEmpty(), body('scope').isArray().notEmpty(), body('otpSystem').notEmpty()],
  validate,
  abhaController.phrRequestOtp
);

router.post(
  '/phr/verify-otp',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('scope').isArray().notEmpty(), body('txnId').notEmpty(), body('otp').notEmpty()],
  validate,
  abhaController.phrVerifyOtp
);

router.get('/phr/profile', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.phrGetProfile);
router.get('/phr/card', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), abhaController.phrGetCard);

// ─────────────────────────────────────────────────────────────────────────────
// PATIENT LINKING
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/link',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty(), body('patientId').notEmpty()],
  validate,
  abhaController.linkToPatient
);

router.post(
  '/unlink',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty(), body('patientId').notEmpty()],
  validate,
  abhaController.unlinkFromPatient
);

router.get(
  '/record/:abhaNumber',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.getLocalRecord
);

// ─────────────────────────────────────────────────────────────────────────────
// NEW vs RETURNING PATIENT LOOKUP
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/patient/lookup',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.lookupPatient
);

export default router;
