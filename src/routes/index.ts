import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import patientRoutes from '../modules/patient/patient.routes';
import doctorRoutes from '../modules/doctor/doctor.routes';
import appointmentRoutes from '../modules/appointment/appointment.routes';
import abhaRoutes from '../modules/abha/abha.routes';
import consentRoutes from '../modules/consent/consent.routes';
import notificationRoutes from './notificationRoutes';
import auditLogRoutes from './auditLogRoutes';
import hospitalRoutes from './hospitalRoutes';
import paymentRoutes from './paymentRoutes';
import encounterRoutes from './encounterRoutes';
import prescriptionRoutes from './prescriptionRoutes';
import vitalsRoutes from './vitalsRoutes';
import investigationRoutes from './investigationRoutes';
import hipRoutes from '../modules/hip/hip.routes';
import hiuRoutes from '../modules/hiu/hiu.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/hospitals', hospitalRoutes);
router.use('/patients', patientRoutes);
router.use('/doctors', doctorRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/abha', abhaRoutes);
router.use('/consents', consentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/payments', paymentRoutes);
router.use('/encounters', encounterRoutes);
router.use('/prescriptions', prescriptionRoutes);
router.use('/vitals', vitalsRoutes);
router.use('/investigations', investigationRoutes);
router.use('/hip', hipRoutes);
router.use('/hiu', hiuRoutes);

export default router;
