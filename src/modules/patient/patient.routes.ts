import { Router } from 'express';
import patientController from './patient.controller';
import { body, query } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('PATIENT'));

/**
 * @openapi
 * /patients:
 *   post:
 *     tags: [Patients]
 *     summary: Register a new patient
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, gender, dob, mobile]
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               gender: { type: string, enum: [MALE, FEMALE, OTHER] }
 *               dob: { type: string, format: date }
 *               mobile: { type: string }
 *               email: { type: string, format: email }
 *               bloodGroup: { type: string, enum: [A+, A-, B+, B-, AB+, AB-, O+, O-] }
 *     responses:
 *       201:
 *         description: Patient registered, returns patient object with UHID
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('firstName').notEmpty().withMessage('First name is required'),
    body('lastName').notEmpty().withMessage('Last name is required'),
    body('gender').isIn(['MALE', 'FEMALE', 'OTHER']).withMessage('Valid gender is required'),
    body('dob').isISO8601().withMessage('Valid date of birth is required'),
    body('mobile').isMobilePhone('en-IN').withMessage('Valid mobile number is required'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Valid email is required'),
    body('bloodGroup').optional({ values: 'falsy' }).isIn(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).withMessage('Invalid blood group'),
    body('abhaNumber').optional({ values: 'falsy' }).matches(/^\d{2}-?\d{4}-?\d{4}-?\d{4}$/).withMessage('ABHA number must be 14 digits (e.g. 91-1234-1234-1234)'),
    body('abhaAddress').optional({ values: 'falsy' }).matches(/^[a-zA-Z0-9._]+@[a-zA-Z0-9]+$/).withMessage('ABHA address must look like name@sbx'),
  ],
  validate,
  patientController.createPatient
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  patientController.getPatientStats
);

/**
 * @openapi
 * /patients/search:
 *   get:
 *     tags: [Patients]
 *     summary: Search and list patients
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search by name, UHID, or mobile
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated patient list
 */
router.get(
  '/search',
  // Patient lookup is needed across the workflow:
  // - Clinical (DOCTOR/NURSE) for charts
  // - Front desk (RECEPTIONIST) for registration / billing
  // - Lab + Pharmacy to identify the patient on a sample / Rx slip.
  // Hospital scope is enforced in the service.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  patientController.searchPatients
);

/**
 * @openapi
 * /patients/{id}:
 *   get:
 *     tags: [Patients]
 *     summary: Get patient by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Patient UUID
 *     responses:
 *       200:
 *         description: Patient details with ABHA record, encounters, and admissions
 *       404:
 *         description: Patient not found
 */
router.get(
  '/:id',
  // Full patient record (incl. encounters/admissions) is restricted to
  // clinical + administrative roles. Lab and Pharmacy use the narrower
  // /uhid/:uhid lookup or the EHR profile endpoint — they should not see
  // the full encounter/admission history embedded in this response.
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  patientController.getPatientById
);

router.get(
  '/uhid/:uhid',
  // UHID lookup is the safe identity endpoint — usable by everyone who
  // has to act on a patient (samples, dispensing, etc.).
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  patientController.getPatientByUHID
);

router.put(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('firstName').optional().notEmpty().withMessage('First name cannot be empty'),
    body('lastName').optional().notEmpty().withMessage('Last name cannot be empty'),
    body('gender').optional().isIn(['MALE', 'FEMALE', 'OTHER']).withMessage('Valid gender is required (MALE, FEMALE, OTHER)'),
    body('dob').optional().isISO8601().withMessage('Valid date of birth is required (YYYY-MM-DD)'),
    body('mobile').optional().isMobilePhone('en-IN').withMessage('Valid Indian mobile number is required'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Valid email is required'),
    body('bloodGroup').optional({ values: 'falsy' }).isIn(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).withMessage('Invalid blood group'),
    body('abhaNumber').optional({ values: 'falsy' }).matches(/^\d{2}-?\d{4}-?\d{4}-?\d{4}$/).withMessage('ABHA number must be 14 digits (e.g. 91-1234-1234-1234)'),
    body('abhaAddress').optional({ values: 'falsy' }).matches(/^[a-zA-Z0-9._]+@[a-zA-Z0-9]+$/).withMessage('ABHA address must look like name@sbx'),
  ],
  validate,
  patientController.updatePatient
);

router.delete(
  '/:id',
  authorize('SUPER_ADMIN'),
  patientController.deletePatient
);

export default router;
