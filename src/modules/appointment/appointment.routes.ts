import { Router } from 'express';
import appointmentController from './appointment.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  [
    body('patientId').notEmpty().withMessage('Patient ID is required'),
    body('doctorId').notEmpty().withMessage('Doctor ID is required'),
    body('date').isISO8601().withMessage('Valid date is required'),
    body('time').matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Valid time is required (HH:MM)'),
    body('type').isIn([
      'OPD',
      'IPD',
      'EMERGENCY',
      'FOLLOW_UP',
      'TELECONSULTATION',
      'ROUTINE_CHECKUP',
      'VACCINATION',
      'DIAGNOSTIC',
      'SURGERY_CONSULTATION',
      'SECOND_OPINION'
    ]).withMessage('Valid appointment type is required'),
  ],
  validate,
  appointmentController.createAppointment
);

router.get(
  '/stats',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  appointmentController.getAppointmentStats
);

router.get(
  '/search',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  appointmentController.searchAppointments
);

router.get(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'),
  appointmentController.getAppointmentById
);

router.put(
  '/:id',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  appointmentController.updateAppointment
);

router.post(
  '/:id/cancel',
  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'),
  appointmentController.cancelAppointment
);

router.post(
  '/:id/check-in',
  authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'),
  appointmentController.checkInAppointment
);

export default router;
