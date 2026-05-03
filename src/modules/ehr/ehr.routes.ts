import { Router } from 'express';
import ehrController from './ehr.controller';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

router.use(authenticate);
router.use(authorize('SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'));

router.get('/patients',            ehrController.getPatientList);
router.get('/patients/:patientId', ehrController.getPatientEHR);

export default router;
