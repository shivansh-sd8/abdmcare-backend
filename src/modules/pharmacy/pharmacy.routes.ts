import { Router } from 'express';
import { authenticate, authorize } from '../../common/middleware/auth';
import { auditLog } from '../../common/middleware/audit';
import {
  listMedicines, getMedicine, createMedicine, updateMedicine, deleteMedicine,
  receiveStock, getStockOverview, getLowStock, getExpiringBatches,
  adjustStock, getStockMovements, getDashboardStats,
} from './pharmacy.controller';

const router = Router();

router.use(authenticate);
router.use(auditLog('PHARMACY'));

// Dashboard stats
router.get('/dashboard', authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), getDashboardStats);

// Medicine master
router.get('/medicines',              authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN', 'DOCTOR'), listMedicines);
router.get('/medicines/:medicineId',  authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN', 'DOCTOR'), getMedicine);
router.post('/medicines',             authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), createMedicine);
router.put('/medicines/:medicineId',  authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), updateMedicine);
router.delete('/medicines/:medicineId', authorize('ADMIN', 'SUPER_ADMIN'), deleteMedicine);

// Stock receive (batch entry)
router.post('/stock/receive', authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), receiveStock);

// Stock overview + alerts
router.get('/stock',          authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), getStockOverview);
router.get('/stock/low',      authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), getLowStock);
router.get('/stock/expiring', authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), getExpiringBatches);

// Stock adjustment
router.post('/stock/adjust', authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), adjustStock);

// Stock movement history (audit trail)
router.get('/stock/movements', authorize('PHARMACIST', 'ADMIN', 'SUPER_ADMIN'), getStockMovements);

export default router;
