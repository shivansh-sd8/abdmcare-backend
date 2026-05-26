import { Router } from 'express';
import { body, query } from 'express-validator';
import abhaController from './abha.controller';
import { authenticate, authorize } from '../../common/middleware/auth';
import { validate } from '../../common/middleware/validation';
import { abhaOtpLimiter } from '../../common/middleware/rateLimiter';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

/**
 * @openapi
 * /abha/health:
 *   get:
 *     tags: [ABHA]
 *     summary: Check ABDM gateway connectivity
 *     security: []
 *     responses:
 *       200:
 *         description: ABDM gateway reachable
 *       503:
 *         description: ABDM gateway unreachable
 */
router.get('/health', abhaController.healthCheck);

// ─────────────────────────────────────────────────────────────────────────────
// All other routes require authentication
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);
router.use(auditLog('ABHA'));

/**
 * @openapi
 * /abha/enrollment/aadhaar/send-otp:
 *   post:
 *     tags: [ABHA]
 *     summary: Send Aadhaar OTP for ABHA enrollment
 *     description: Initiates ABHA creation via Aadhaar. Sends OTP to Aadhaar-linked mobile.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [aadhaar]
 *             properties:
 *               aadhaar: { type: string, description: Aadhaar number (12 digits) }
 *     responses:
 *       200:
 *         description: OTP sent — returns txnId for subsequent verification
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/enrollment/aadhaar/send-otp',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('aadhaar').notEmpty().withMessage('aadhaar is required')],
  validate,
  abhaController.generateAadhaarOtp
);

router.post(
  '/enrollment/aadhaar/resend-otp',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('aadhaar').notEmpty().withMessage('aadhaar is required'),
  ],
  validate,
  abhaController.resendAadhaarOtp
);

/**
 * @openapi
 * /abha/enrollment/aadhaar/enrol:
 *   post:
 *     tags: [ABHA]
 *     summary: Complete ABHA enrollment with Aadhaar OTP
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [txnId, otp]
 *             properties:
 *               txnId: { type: string }
 *               otp: { type: string }
 *     responses:
 *       200:
 *         description: ABHA created — returns ABHA number, profile, and tokens
 *       400:
 *         description: Invalid or expired OTP
 */
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
  abhaOtpLimiter,
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
  abhaOtpLimiter,
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

/**
 * @openapi
 * /abha/login/request-otp:
 *   post:
 *     tags: [ABHA]
 *     summary: Request OTP for ABHA login/verification
 *     description: Supports multiple login methods — ABHA number, mobile, or Aadhaar.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [scope, loginHint, loginId, otpSystem]
 *             properties:
 *               scope: { type: array, items: { type: string } }
 *               loginHint: { type: string, enum: [abha-number, mobile, aadhaar] }
 *               loginId: { type: string }
 *               otpSystem: { type: string, enum: [abdm, aadhaar] }
 *     responses:
 *       200:
 *         description: OTP sent — returns txnId
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/login/request-otp',
  abhaOtpLimiter,
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
// FORGOT ABHA / ENROLMENT NUMBER RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/forgot-abha/request-otp',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('abhaAddress').notEmpty().withMessage('abhaAddress is required'),
    body('authMethod').notEmpty().withMessage('authMethod is required (aadhaar or mobile)'),
  ],
  validate,
  abhaController.forgotAbhaRequestOtp
);

router.post(
  '/forgot-abha/verify',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('otp').notEmpty().withMessage('otp is required'),
  ],
  validate,
  abhaController.forgotAbhaVerify
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
  abhaOtpLimiter,
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

// ── Email Verification ────────────────────────────────────────────────────────

router.post(
  '/profile/email-verification',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.requestEmailVerification
);

// ── Password Set / Update ─────────────────────────────────────────────────────

router.post(
  '/profile/set-password',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')],
  validate,
  abhaController.setAbhaPassword
);

router.post(
  '/profile/update-password',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('oldPassword').notEmpty().withMessage('oldPassword is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('newPassword must be at least 8 characters'),
  ],
  validate,
  abhaController.updateAbhaPassword
);

// ── Re-KYC ────────────────────────────────────────────────────────────────────

router.post(
  '/profile/rekyc',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('authMethod').notEmpty().withMessage('authMethod is required (aadhaar or mobile)')],
  validate,
  abhaController.requestReKyc
);

// ── Refresh Token ─────────────────────────────────────────────────────────────

router.post(
  '/profile/refresh-token',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('refreshToken').notEmpty().withMessage('refreshToken is required')],
  validate,
  abhaController.refreshAbhaToken
);

// ── Delete ABHA ───────────────────────────────────────────────────────────────

router.post(
  '/profile/delete/request-otp',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.deleteAbhaRequestOtp
);

router.post(
  '/profile/delete/confirm',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('otp').notEmpty().withMessage('otp is required'),
  ],
  validate,
  abhaController.deleteAbhaConfirm
);

// ── Deactivate / Reactivate ABHA ─────────────────────────────────────────────

router.post(
  '/profile/deactivate',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  abhaController.deactivateAbha
);

router.post(
  '/profile/reactivate/request-otp',
  abhaOtpLimiter,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty().withMessage('abhaNumber is required')],
  validate,
  abhaController.reactivateAbhaRequestOtp
);

router.post(
  '/profile/reactivate/confirm',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('txnId').notEmpty().withMessage('txnId is required'),
    body('otp').notEmpty().withMessage('otp is required'),
  ],
  validate,
  abhaController.reactivateAbhaConfirm
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

/**
 * @openapi
 * /abha/link:
 *   post:
 *     tags: [ABHA]
 *     summary: Link ABHA number to a local patient record
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [abhaNumber, patientId]
 *             properties:
 *               abhaNumber: { type: string }
 *               patientId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: ABHA linked to patient successfully
 *       404:
 *         description: Patient or ABHA record not found
 */
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
