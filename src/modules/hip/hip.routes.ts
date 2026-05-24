import { Router } from 'express';
import hipController from './hip.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ABDM V3 CALLBACKS (no local auth — ABDM verifies via token)
// ─────────────────────────────────────────────────────────────────────────────

// Scan & Share
router.post('/patient/share', hipController.handleProfileShare);

// User Initiated Linking callbacks (ABDM → HIP)
router.post('/patient/care-context/discover', hipController.discoverCareContexts);
router.post('/link/care-context/init', hipController.linkCareContexts);
router.post('/link/care-context/confirm', hipController.confirmLinkCareContexts);

// Data Transfer callbacks (ABDM → HIP)
router.post('/consent/notify', hipController.handleConsentHipNotify);
router.post('/health-information/request', hipController.handleHealthInformationRequest);

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL APIs (auth required) — M2 HIP-initiated actions
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

// M1: Facility QR data & received shares
router.get(
  '/facility-qr',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  hipController.getFacilityQrData
);

router.get(
  '/received-shares',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  hipController.getReceivedShares
);

router.post(
  '/link/generate-token',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('abhaNumber').notEmpty(),
    body('abhaAddress').notEmpty(),
    body('name').notEmpty(),
    body('gender').notEmpty(),
    body('yearOfBirth').isInt(),
  ],
  validate,
  hipController.generateLinkToken
);

router.post(
  '/link/carecontext',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaNumber').notEmpty(), body('abhaAddress').notEmpty(), body('patient').isArray()],
  validate,
  hipController.hipInitiatedLink
);

router.post(
  '/link/context/notify',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('abhaAddress').notEmpty(), body('careContextReference').notEmpty()],
  validate,
  hipController.linkContextNotify
);

router.post(
  '/sms/notify',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('phoneNo').notEmpty()],
  validate,
  hipController.smsNotify
);

router.post(
  '/patients/:patientId/care-contexts',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('careContexts').isArray().withMessage('Care contexts must be an array'),
    body('careContexts.*.encounterId').notEmpty(),
    body('careContexts.*.display').notEmpty(),
  ],
  validate,
  hipController.addCareContexts
);

export default router;
