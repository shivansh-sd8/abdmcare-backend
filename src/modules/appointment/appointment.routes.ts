import { Router } from 'express';
import appointmentController from './appointment.controller';
import { body } from 'express-validator';
import { validate } from '../../common/middleware/validation';
import { authenticate } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);

router.post(
  '/',
  [
    body('patientId').notEmpty().withMessage('Patient ID is required'),
    body('doctorId').notEmpty().withMessage('Doctor ID is required'),
    body('date').isISO8601().withMessage('Valid date is required'),
    body('time').matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Valid time is required (HH:MM)'),
    body('type').isIn(['CONSULTATION', 'FOLLOWUP', 'EMERGENCY']).withMessage('Valid appointment type is required'),
  ],
  validate,
  appointmentController.createAppointment
);

router.get('/stats', appointmentController.getAppointmentStats);

router.get('/search', appointmentController.searchAppointments);

router.get('/:id', appointmentController.getAppointmentById);

router.put('/:id', appointmentController.updateAppointment);

router.post('/:id/cancel', appointmentController.cancelAppointment);

export default router;
