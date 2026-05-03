import { Router } from 'express';
import { authenticate, authorize } from '../../common/middleware/auth';
import {
  listWards, createWard, updateWard,
  createBed, updateBedStatus,
  listAdmissions, getAdmission, admitPatient, updateAdmission, dischargePatient,
  getWardOverview,
  getAdmissionRounds, createAdmissionRound, markDischargeReady, getAdmissionBill,
} from './ipd.controller';

const router = Router();

router.use(authenticate);

// Ward management (ADMIN sets up wards + daily charges)
router.get('/wards',               authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), listWards);
router.post('/wards',              authorize('SUPER_ADMIN', 'ADMIN'), createWard);
router.put('/wards/:wardId',       authorize('SUPER_ADMIN', 'ADMIN'), updateWard);

// Bed management
router.post('/wards/:wardId/beds', authorize('SUPER_ADMIN', 'ADMIN', 'NURSE'), createBed);
router.put('/beds/:bedId/status',  authorize('SUPER_ADMIN', 'ADMIN', 'NURSE'), updateBedStatus);

// Admissions — who can admit: RECEPTIONIST (finalises) or DOCTOR/ADMIN
router.get('/admissions',                                  authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), listAdmissions);
router.post('/admissions',                                 authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), admitPatient);
router.get('/admissions/:admissionId',                     authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), getAdmission);
router.put('/admissions/:admissionId',                     authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'), updateAdmission);

// Discharge: RECEPTIONIST collects payment + discharges; DOCTOR/ADMIN can also discharge
router.post('/admissions/:admissionId/discharge',          authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), dischargePatient);

// Doctor marks patient clinically ready for discharge; receptionist then handles payment
router.post('/admissions/:admissionId/discharge-ready',    authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), markDischargeReady);

// IPD Daily Rounds — doctor adds ongoing notes/prescriptions/labs while patient is admitted
router.get('/admissions/:admissionId/rounds',              authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), getAdmissionRounds);
router.post('/admissions/:admissionId/rounds',             authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR'), createAdmissionRound);

// Bill preview (before discharge)
router.get('/admissions/:admissionId/bill',                authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), getAdmissionBill);

// Ward overview / ward manager
router.get('/overview', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), getWardOverview);

export default router;
