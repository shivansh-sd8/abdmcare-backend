import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import abhaRoutes from '../modules/abha/abha.routes';
import patientRoutes from '../modules/patient/patient.routes';
import doctorRoutes from '../modules/doctor/doctor.routes';
import appointmentRoutes from '../modules/appointment/appointment.routes';
import hipRoutes from '../modules/hip/hip.routes';
import hiuRoutes from '../modules/hiu/hiu.routes';
import consentRoutes from '../modules/consent/consent.routes';
import notificationRoutes from './notificationRoutes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/abha', abhaRoutes);
router.use('/patients', patientRoutes);
router.use('/doctors', doctorRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/hip', hipRoutes);
router.use('/hiu', hiuRoutes);
router.use('/consents', consentRoutes);
router.use('/notifications', notificationRoutes);

export default router;
