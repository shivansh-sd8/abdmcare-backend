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

const createValidation = [
  body('name')
    .trim().notEmpty().withMessage('Hospital name is required')
    .isLength({ min: 2, max: 200 }).withMessage('Hospital name must be 2-200 characters'),
  body('type')
    .optional()
    .isIn(HOSPITAL_TYPES).withMessage(`Type must be one of: ${HOSPITAL_TYPES.join(', ')}`),
  body('email')
    .trim().notEmpty().withMessage('Hospital email is required')
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
    .isURL().withMessage('Valid URL is required (e.g. https://example.com)'),
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
    .matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/)
    .withMessage('Invalid GST number (e.g. 22AAAAA0000A1Z5)'),
  body('panNumber')
    .optional({ values: 'falsy' })
    .matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/)
    .withMessage('Invalid PAN number (e.g. ABCDE1234F)'),
  body('licenseNumber')
    .optional({ values: 'falsy' })
    .isLength({ min: 3, max: 50 }).withMessage('License number must be 3-50 characters'),
  body('establishedYear')
    .optional({ values: 'falsy' })
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage(`Established year must be between 1800 and ${new Date().getFullYear()}`),
  body('ownerName')
    .optional({ values: 'falsy' })
    .isLength({ min: 2, max: 100 }).withMessage('Owner name must be 2-100 characters'),
  body('ownerEmail')
    .optional({ values: 'falsy' })
    .isEmail().withMessage('Valid owner email is required')
    .normalizeEmail(),
  body('ownerPhone')
    .optional({ values: 'falsy' })
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
  body('adminUsername')
    .optional({ values: 'falsy' })
    .isLength({ min: 3, max: 50 }).withMessage('Admin username must be 3-50 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('adminPassword')
    .optional({ values: 'falsy' })
    .isLength({ min: 6 }).withMessage('Admin password must be at least 6 characters'),
  body('adminFirstName')
    .optional({ values: 'falsy' })
    .isLength({ min: 1, max: 50 }).withMessage('Admin first name must be 1-50 characters'),
  body('adminLastName')
    .optional({ values: 'falsy' })
    .isLength({ min: 1, max: 50 }).withMessage('Admin last name must be 1-50 characters'),
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
];

const updateValidation = [
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
    .isURL().withMessage('Valid URL is required'),
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
    .matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/)
    .withMessage('Invalid GST number (e.g. 22AAAAA0000A1Z5)'),
  body('panNumber')
    .optional({ values: 'falsy' })
    .matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/)
    .withMessage('Invalid PAN number (e.g. ABCDE1234F)'),
  body('establishedYear')
    .optional({ values: 'falsy' })
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage(`Year must be between 1800 and ${new Date().getFullYear()}`),
  body('ownerEmail')
    .optional({ values: 'falsy' })
    .isEmail().withMessage('Valid owner email is required'),
  body('ownerPhone')
    .optional({ values: 'falsy' })
    .matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit Indian phone number is required'),
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
