import { Router } from 'express';
import { body } from 'express-validator';
import hospitalController from './hospital.controller';
import { authenticate, authorize } from '../../common/middleware/auth';
import { validate } from '../../common/middleware/validation';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

// Audit every authenticated hospital operation. Public routes below `authenticate`
// are not audited.
router.use(auditLog('HOSPITAL'));

const HOSPITAL_TYPES = [
  'HOSPITAL', 'CLINIC', 'NURSING_HOME', 'DIAGNOSTIC_CENTER',
  'POLYCLINIC', 'SPECIALTY_CENTER', 'MULTI_SPECIALTY', 'SUPER_SPECIALTY',
];
const PLAN_TYPES = ['FREE', 'BASIC', 'PROFESSIONAL', 'ENTERPRISE'];

// ─── ABDM identifier formats (per HFR docs / sandbox samples) ──────────────
// Real HFR Facility IDs are `IN<10 digits>` (e.g. IN3410000260, IN0610090166).
// HIP IDs typically equal the HFR ID, with an optional `_<counter>` suffix
// for sub-counters within a multi-counter facility (e.g. IN2710000362_1).
// HIU IDs in production follow the HFR pattern; in sandbox they can be
// arbitrary tokens (e.g. N_SBX_HIU_V3) — kept lenient here.
const HFR_FACILITY_ID_RE = /^IN\d{10}$/;
const HIP_ID_RE = /^IN\d{10}(?:_[A-Za-z0-9]{1,16})?$/;
const HIU_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

const createValidation = [
  // Strip any client-provided code — server always generates it. We accept
  // and ignore (`.customSanitizer(() => undefined)`) so older clients don't
  // get a 422 for an extra field.
  body('code').customSanitizer(() => undefined),

  body('name')
    .trim().notEmpty().withMessage('Hospital name is required')
    .isLength({ min: 2, max: 200 }).withMessage('Hospital name must be 2-200 characters'),
  body('type')
    .optional()
    .isIn(HOSPITAL_TYPES).withMessage(`Type must be one of: ${HOSPITAL_TYPES.join(', ')}`),
  body('email')
    .trim().notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Valid email address is required')
    .normalizeEmail(),
  body('phone')
    .trim().notEmpty().withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
  body('alternatePhone')
    .optional({ values: 'falsy' })
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
  body('website')
    .optional({ values: 'falsy' })
    .isURL({ require_protocol: true, protocols: ['http', 'https'] })
    .withMessage('Website must be a full URL (e.g. https://example.com)'),
  body('addressLine1')
    .trim().notEmpty().withMessage('Address Line 1 is required')
    .isLength({ min: 3, max: 500 }).withMessage('Address must be 3-500 characters'),
  body('addressLine2')
    .optional({ values: 'falsy' })
    .isLength({ max: 500 }).withMessage('Address Line 2 must be under 500 characters'),
  body('city')
    .trim().notEmpty().withMessage('City is required')
    .isLength({ min: 2, max: 100 }).withMessage('City must be 2-100 characters'),
  body('state')
    .trim().notEmpty().withMessage('State is required')
    .isLength({ min: 2, max: 100 }).withMessage('State must be 2-100 characters'),
  body('pincode')
    .trim().notEmpty().withMessage('Pincode is required')
    .matches(/^\d{6}$/).withMessage('Pincode must be exactly 6 digits'),
  body('landmark')
    .optional({ values: 'falsy' })
    .isLength({ max: 200 }).withMessage('Landmark must be under 200 characters'),
  body('registrationNumber')
    .optional({ values: 'falsy' })
    .isLength({ min: 3, max: 50 }).withMessage('Registration number must be 3-50 characters'),
  body('gstNumber')
    .optional({ values: 'falsy' })
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/)
    .withMessage('Invalid GST number (e.g. 22AAAAA0000A1Z5)'),
  body('panNumber')
    .optional({ values: 'falsy' })
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/)
    .withMessage('Invalid PAN number (e.g. ABCDE1234F)'),
  body('licenseNumber')
    .optional({ values: 'falsy' })
    .isLength({ min: 3, max: 50 }).withMessage('License number must be 3-50 characters'),
  body('establishedYear')
    .optional({ values: 'falsy' })
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage(`Established year must be between 1800 and ${new Date().getFullYear()}`),

  // ── Primary Admin (REQUIRED — atomic block) ──────────────────────────────
  body('adminUsername')
    .trim().notEmpty().withMessage('Admin username is required')
    .isLength({ min: 3, max: 50 }).withMessage('Admin username must be 3-50 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('adminPassword')
    .notEmpty().withMessage('Admin password is required')
    .isLength({ min: 8, max: 128 }).withMessage('Admin password must be at least 8 characters'),
  body('adminFirstName')
    .trim().notEmpty().withMessage('Admin first name is required')
    .isLength({ min: 1, max: 50 }).withMessage('Admin first name must be 1-50 characters'),
  body('adminLastName')
    .trim().notEmpty().withMessage('Admin last name is required')
    .isLength({ min: 1, max: 50 }).withMessage('Admin last name must be 1-50 characters'),
  body('adminPhone')
    .trim().notEmpty().withMessage('Admin mobile is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian mobile number is required'),

  body('totalBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('Total beds must be 0-10,000'),
  body('icuBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('ICU beds must be 0-10,000'),
  body('emergencyBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('Emergency beds must be 0-10,000'),
  body('operationTheaters')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 1000 }).withMessage('Operation theaters must be 0-1,000'),
  body('plan')
    .optional()
    .isIn(PLAN_TYPES).withMessage(`Plan must be one of: ${PLAN_TYPES.join(', ')}`),
  body('defaultOpdCharge')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 100000 }).withMessage('Default OPD charge must be 0-1,00,000'),

  // ── ABDM Integration (per-facility identifiers from HFR/NHA) ─────────────
  body('hipId')
    .optional({ values: 'falsy' })
    .matches(HIP_ID_RE)
    .withMessage('HIP ID must look like IN<10 digits> (e.g. IN3410000260) — optionally suffixed with _<counter>'),
  body('hipName')
    .optional({ values: 'falsy' })
    .isLength({ min: 2, max: 200 }).withMessage('HIP display name must be 2-200 characters'),
  body('hiuId')
    .optional({ values: 'falsy' })
    .matches(HIU_ID_RE)
    .withMessage('HIU ID must be 4-40 chars (letters, digits, _ or -)'),
  body('hiuName')
    .optional({ values: 'falsy' })
    .isLength({ min: 2, max: 200 }).withMessage('HIU display name must be 2-200 characters'),
  body('hfrFacilityId')
    .optional({ values: 'falsy' })
    .matches(HFR_FACILITY_ID_RE)
    .withMessage('HFR Facility ID must be IN followed by exactly 10 digits (e.g. IN3410000260)'),

  // ── Stripped fields (silently ignored — superseded by other inputs) ──────
  body('ownerName').customSanitizer(() => undefined),
  body('ownerEmail').customSanitizer(() => undefined),
  body('ownerPhone').customSanitizer(() => undefined),
  body('abdmClientId').customSanitizer(() => undefined),
  body('abdmClientSecret').customSanitizer(() => undefined),
  body('abdmCallbackUrl').customSanitizer(() => undefined),
];

const updateValidation = [
  body('code').customSanitizer(() => undefined),
  body('name')
    .optional().trim().notEmpty().withMessage('Hospital name cannot be empty')
    .isLength({ min: 2, max: 200 }).withMessage('Hospital name must be 2-200 characters'),
  body('type')
    .optional()
    .isIn(HOSPITAL_TYPES).withMessage(`Type must be one of: ${HOSPITAL_TYPES.join(', ')}`),
  body('email')
    .optional().trim().notEmpty().withMessage('Email cannot be empty')
    .isEmail().withMessage('Valid email address is required')
    .normalizeEmail(),
  body('phone')
    .optional().trim().notEmpty().withMessage('Phone cannot be empty')
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
  body('alternatePhone')
    .optional({ values: 'falsy' })
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
  body('website')
    .optional({ values: 'falsy' })
    .isURL({ require_protocol: true, protocols: ['http', 'https'] })
    .withMessage('Website must be a full URL (e.g. https://example.com)'),
  body('addressLine1')
    .optional().trim().notEmpty().withMessage('Address Line 1 cannot be empty')
    .isLength({ min: 3, max: 500 }).withMessage('Address must be 3-500 characters'),
  body('city')
    .optional().trim().notEmpty().withMessage('City cannot be empty')
    .isLength({ min: 2, max: 100 }).withMessage('City must be 2-100 characters'),
  body('state')
    .optional().trim().notEmpty().withMessage('State cannot be empty')
    .isLength({ min: 2, max: 100 }).withMessage('State must be 2-100 characters'),
  body('pincode')
    .optional().trim().notEmpty().withMessage('Pincode cannot be empty')
    .matches(/^\d{6}$/).withMessage('Pincode must be exactly 6 digits'),
  body('gstNumber')
    .optional({ values: 'falsy' })
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/)
    .withMessage('Invalid GST number (e.g. 22AAAAA0000A1Z5)'),
  body('panNumber')
    .optional({ values: 'falsy' })
    .customSanitizer((v) => (typeof v === 'string' ? v.toUpperCase() : v))
    .matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/)
    .withMessage('Invalid PAN number (e.g. ABCDE1234F)'),
  body('establishedYear')
    .optional({ values: 'falsy' })
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage(`Year must be between 1800 and ${new Date().getFullYear()}`),
  body('totalBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('Total beds must be 0-10,000'),
  body('icuBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('ICU beds must be 0-10,000'),
  body('emergencyBeds')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 10000 }).withMessage('Emergency beds must be 0-10,000'),
  body('operationTheaters')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 1000 }).withMessage('Operation theaters must be 0-1,000'),
  body('plan')
    .optional()
    .isIn(PLAN_TYPES).withMessage(`Plan must be one of: ${PLAN_TYPES.join(', ')}`),
  body('defaultOpdCharge')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0, max: 100000 }).withMessage('Default OPD charge must be 0-1,00,000'),

  // ── Admin-side edits (optional on update; propagate to the linked user). ──
  body('adminUsername')
    .optional({ values: 'falsy' })
    .isLength({ min: 3, max: 50 }).withMessage('Admin username must be 3-50 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('adminPassword')
    .optional({ values: 'falsy' })
    .isLength({ min: 8, max: 128 }).withMessage('Admin password must be at least 8 characters'),
  body('adminFirstName')
    .optional({ values: 'falsy' })
    .isLength({ min: 1, max: 50 }).withMessage('Admin first name must be 1-50 characters'),
  body('adminLastName')
    .optional({ values: 'falsy' })
    .isLength({ min: 1, max: 50 }).withMessage('Admin last name must be 1-50 characters'),
  body('adminPhone')
    .optional({ values: 'falsy' })
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian mobile number is required'),

  // ── ABDM Integration ─────────────────────────────────────────────────────
  body('hipId')
    .optional({ values: 'falsy' })
    .matches(HIP_ID_RE)
    .withMessage('HIP ID must look like IN<10 digits> (e.g. IN3410000260) — optionally suffixed with _<counter>'),
  body('hipName')
    .optional({ values: 'falsy' })
    .isLength({ min: 2, max: 200 }).withMessage('HIP display name must be 2-200 characters'),
  body('hiuId')
    .optional({ values: 'falsy' })
    .matches(HIU_ID_RE)
    .withMessage('HIU ID must be 4-40 chars (letters, digits, _ or -)'),
  body('hiuName')
    .optional({ values: 'falsy' })
    .isLength({ min: 2, max: 200 }).withMessage('HIU display name must be 2-200 characters'),
  body('hfrFacilityId')
    .optional({ values: 'falsy' })
    .matches(HFR_FACILITY_ID_RE)
    .withMessage('HFR Facility ID must be IN followed by exactly 10 digits (e.g. IN3410000260)'),

  // ── Stripped fields (silently ignored — superseded by other inputs) ──────
  body('ownerName').customSanitizer(() => undefined),
  body('ownerEmail').customSanitizer(() => undefined),
  body('ownerPhone').customSanitizer(() => undefined),
  body('abdmClientId').customSanitizer(() => undefined),
  body('abdmClientSecret').customSanitizer(() => undefined),
  body('abdmCallbackUrl').customSanitizer(() => undefined),
];

router.post(
  '/',
  authenticate,
  authorize('SUPER_ADMIN'),
  createValidation,
  validate,
  hospitalController.onboardHospital
);

router.get(
  '/',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.getAllHospitals
);

router.get(
  '/stats',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.getHospitalStats
);

router.get(
  '/:id/stats',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  hospitalController.getHospitalPerformance
);

router.get(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  hospitalController.getHospitalById
);

router.put(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  updateValidation,
  validate,
  hospitalController.updateHospital
);

router.put(
  '/:id/plan',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.updateHospitalPlan
);

router.get(
  '/:id/schedule',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  hospitalController.getSchedule
);

router.put(
  '/:id/schedule',
  authenticate,
  authorize('SUPER_ADMIN', 'ADMIN'),
  hospitalController.updateSchedule
);

router.delete(
  '/:id',
  authenticate,
  authorize('SUPER_ADMIN'),
  hospitalController.deleteHospital
);

export default router;
