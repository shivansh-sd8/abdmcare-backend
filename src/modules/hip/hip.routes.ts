import { Router } from 'express';
import hipController from './hip.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { verifyAbdmCallback } from '../../common/middleware/verifyAbdmCallback';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ABDM V3 CALLBACKS (verified via ABDM JWT from /v3/certs JWKS)
// ─────────────────────────────────────────────────────────────────────────────

// Scan & Share
router.post('/patient/share', verifyAbdmCallback, hipController.handleProfileShare);

// User Initiated Linking callbacks (ABDM → HIP)
router.post('/patient/care-context/discover', verifyAbdmCallback, hipController.discoverCareContexts);
router.post('/link/care-context/init', verifyAbdmCallback, hipController.linkCareContexts);
router.post('/link/care-context/confirm', verifyAbdmCallback, hipController.confirmLinkCareContexts);

// Data Transfer callbacks (ABDM → HIP)
router.post('/consent/notify', verifyAbdmCallback, hipController.handleConsentHipNotify);
router.post('/health-information/request', verifyAbdmCallback, hipController.handleHealthInformationRequest);

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL APIs (auth required) — M2 HIP-initiated actions
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);
router.use(auditLog('HIP'));

// M1: HFR / HIP Registration
router.post(
  '/register',
  authorize('SUPER_ADMIN', 'ADMIN'),
  hipController.registerHipService
);

// M1: HIU Registration (mirrors HIP)
router.post(
  '/register-hiu',
  authorize('SUPER_ADMIN', 'ADMIN'),
  hipController.registerHiuService
);

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

// Find Patients in this hospital that look like a probable match for a
// pending share (same mobile, same ABHA-already-linked, or same name+DOB).
// The front desk uses this to offer "merge into existing" before creating a
// brand new patient row.
router.get(
  '/received-shares/:id/match-candidates',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  hipController.getReceivedShareMatchCandidates
);

// Convert a PENDING share into a Patient — either by creating a new row or
// merging the ABHA into an existing patient. Body:
//   { mode: 'NEW' | 'MERGE' | 'IGNORE', existingPatientId?: string }
router.post(
  '/received-shares/:id/convert',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [body('mode').isIn(['NEW', 'MERGE', 'IGNORE'])],
  validate,
  hipController.convertReceivedShare
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

// Hospital-wide list of care contexts (for the "Linked Contexts" tab in the
// Consent Manager). Scoped to the caller's hospital.
router.get(
  '/care-contexts',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  hipController.listCareContexts
);

router.get(
  '/patients/:patientId/care-contexts',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  hipController.getCareContexts
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
