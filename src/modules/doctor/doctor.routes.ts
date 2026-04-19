import { Router } from 'express';
import doctorController from './doctor.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
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

router.get('/stats', doctorController.getDoctorStats);

router.get('/search', doctorController.searchDoctors);

router.get('/:id', doctorController.getDoctorById);

router.put('/:id', doctorController.updateDoctor);

router.delete('/:id', doctorController.deleteDoctor);

export default router;
