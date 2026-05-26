import { Router } from 'express';
import ehrController from './ehr.controller';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';

const router = Router();

router.use(authenticate);
router.use(auditLog('EHR'));
router.use(authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'LAB_TECHNICIAN'));

router.get('/patients',                    ehrController.getPatientList);
router.get('/patients/:patientId',         ehrController.getPatientEHR);
router.get('/patients/:patientId/profile', ehrController.getPatientProfile);

export default router;
