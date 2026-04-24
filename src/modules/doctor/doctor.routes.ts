import { Router } from 'express';
import doctorController from './doctor.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN'),
  [
    body('firstName').notEmpty().withMessage('First name is required'),
    body('lastName').notEmpty().withMessage('Last name is required'),
    body('specialization').notEmpty().withMessage('Specialization is required'),
    body('qualification').notEmpty().withMessage('Qualification is required'),
    body('registrationNo').notEmpty().withMessage('Registration number is required'),
    body('mobile').isMobilePhone('en-IN').withMessage('Valid mobile number is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
  ],
  validate,
  doctorController.createDoctor
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN'),
  doctorController.getDoctorStats
);

router.get(
  '/search',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  doctorController.searchDoctors
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  doctorController.getDoctorById
);

router.put(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN'),
  doctorController.updateDoctor
);

router.delete(
  '/:id',
  authorize('SUPER_ADMIN'),
  doctorController.deleteDoctor
);

export default router;
