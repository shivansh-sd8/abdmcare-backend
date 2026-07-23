import { Router } from 'express';
import reportController from './report.controller';
import { authenticate, authorize } from '../../common/middleware/auth';

const router = Router();

// All report endpoints require an authenticated ADMIN or SUPER_ADMIN.
// SUPER_ADMIN's hospital scope is enforced inside the service via
// getEffectiveHospitalId — they MUST have a scoped hospital because v1
// of this feature is single-hospital reports only.
router.use(authenticate);
router.use(authorize('SUPER_ADMIN', 'ADMIN'));

router.get('/hospital', reportController.getReportJson);
router.get('/hospital.pdf', reportController.downloadPdf);
router.get('/hospital.xlsx', reportController.downloadXlsx);
router.get('/hospital.zip', reportController.downloadZip);

export default router;
