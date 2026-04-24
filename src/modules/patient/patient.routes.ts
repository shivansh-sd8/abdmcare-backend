import { Router } from 'express';
import patientController from './patient.controller';
import { body, query } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('firstName').notEmpty().withMessage('First name is required'),
    body('lastName').notEmpty().withMessage('Last name is required'),
    body('gender').isIn(['MALE', 'FEMALE', 'OTHER']).withMessage('Valid gender is required'),
    body('dob').isISO8601().withMessage('Valid date of birth is required'),
    body('mobile').isMobilePhone('en-IN').withMessage('Valid mobile number is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
  ],
  validate,
  patientController.createPatient
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  patientController.getPatientStats
);

router.get(
  '/search',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  ],
  validate,
  patientController.searchPatients
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN', 'PHARMACIST'),
  patientController.getPatientById
);

router.get(
  '/uhid/:uhid',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  patientController.getPatientByUHID
);

router.put(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  [
    body('firstName').optional().notEmpty().withMessage('First name cannot be empty'),
    body('lastName').optional().notEmpty().withMessage('Last name cannot be empty'),
    body('mobile').optional().isMobilePhone('en-IN').withMessage('Valid mobile number is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
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
