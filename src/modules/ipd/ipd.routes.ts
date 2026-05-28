import { Router } from 'express';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';
import {
  listWards, createWard, updateWard,
  createBed, updateBedStatus,
  listAdmissions, getAdmission, admitPatient, updateAdmission, dischargePatient,
  getWardOverview,
  getAdmissionRounds, createAdmissionRound, markDischargeReady, getAdmissionBill,
  getDischargeSummary, applyDiscount, collectPayment,
  deleteBed, deleteWard,
  bulkCreateBeds, updateBedDetails, transferBed, getTransferHistory, getBedAnalytics,
} from './ipd.controller';

const router = Router();

router.use(authenticate);
router.use(auditLog('IPD'));

// Ward management (ADMIN sets up wards + daily charges)
router.get('/wards',               authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), listWards);
router.post('/wards',              authorize('SUPER_ADMIN', 'ADMIN'), createWard);
router.put('/wards/:wardId',       authorize('SUPER_ADMIN', 'ADMIN'), updateWard);

// Bed management
router.post('/wards/:wardId/beds', authorize('SUPER_ADMIN', 'ADMIN', 'NURSE'), createBed);
router.put('/beds/:bedId/status',  authorize('SUPER_ADMIN', 'ADMIN', 'NURSE'), updateBedStatus);
router.delete('/beds/:bedId',      authorize('SUPER_ADMIN', 'ADMIN'), deleteBed);
router.delete('/wards/:wardId',    authorize('SUPER_ADMIN', 'ADMIN'), deleteWard);

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

// Discount (admin-only)
router.patch('/admissions/:admissionId/discount',          authorize('SUPER_ADMIN', 'ADMIN'), applyDiscount);

// Collect partial payment during stay
router.patch('/admissions/:admissionId/collect-payment',   authorize('SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'), collectPayment);

// Bill preview (before discharge)
router.get('/admissions/:admissionId/bill',                authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), getAdmissionBill);

// Discharge summary data (for PDF generation)
router.get('/admissions/:admissionId/discharge-summary',   authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'RECEPTIONIST'), getDischargeSummary);

// Ward overview / ward manager
router.get('/overview', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), getWardOverview);

// Bed management (admin)
router.post('/wards/:wardId/beds/bulk',         authorize('SUPER_ADMIN', 'ADMIN'), bulkCreateBeds);
router.put('/beds/:bedId/details',              authorize('SUPER_ADMIN', 'ADMIN', 'NURSE'), updateBedDetails);
router.post('/beds/transfer',                   authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE'), transferBed);
router.get('/admissions/:admissionId/transfers', authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), getTransferHistory);
router.get('/analytics/beds',                   authorize('SUPER_ADMIN', 'ADMIN'), getBedAnalytics);

export default router;
