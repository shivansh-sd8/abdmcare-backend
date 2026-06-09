import { Request, Response, NextFunction } from 'express';
import pharmacyService from './pharmacy.service';
import { AppError } from '../../common/middleware/errorHandler';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

function resolveHospitalId(req: Request): string {
  const user = (req as any).user;
  if (!user) throw new AppError('Unauthorized', 401);
  if (user.role === 'SUPER_ADMIN') {
    const fromReq =
      (req.query?.hospitalId as string) ||
      (req.body?.hospitalId as string) ||
      user.hospitalId;
    if (!fromReq) throw new AppError('hospitalId is required for super admin', 400);
    return fromReq;
  }
  if (!user.hospitalId) throw new AppError('Your account is not linked to a hospital', 403);
  return user.hospitalId;
}

// ── Medicine ──────────────────────────────────────────────────────────────────

export async function listMedicines(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const { search, category, page, limit } = req.query as any;
    const data = await pharmacyService.listMedicines(hospitalId, {
      search,
      category,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getMedicine(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.getMedicine(req.params.medicineId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function createMedicine(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.createMedicine(hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function updateMedicine(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.updateMedicine(req.params.medicineId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function deleteMedicine(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.deleteMedicine(req.params.medicineId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

// ── Stock ─────────────────────────────────────────────────────────────────────

export async function receiveStock(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const userId = (req as any).user.id;
    const data = await pharmacyService.receiveStock(hospitalId, userId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function getStockOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.getStockOverview(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getLowStock(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.getLowStockMedicines(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getExpiringBatches(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const days = req.query.days ? parseInt(req.query.days as string) : 90;
    const data = await pharmacyService.getExpiringBatches(hospitalId, days);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function adjustStock(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const userId = (req as any).user.id;
    const data = await pharmacyService.adjustStock(hospitalId, userId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getStockMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const { medicineId, type, page, limit } = req.query as any;
    const data = await pharmacyService.getStockMovements(hospitalId, {
      medicineId,
      type,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getDashboardStats(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await pharmacyService.getDashboardStats(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}
