import { Request, Response } from 'express';
import pharmacyService from './pharmacy.service';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

function err(res: Response, error: any, status = 500) {
  const msg = error?.message || 'Internal server error';
  const code = msg.includes('not found') ? 404
    : msg.includes('already') || msg.includes('negative') ? 409
    : status;
  res.status(code).json({ success: false, message: msg });
}

// ── Medicine ──────────────────────────────────────────────────────────────────

export async function listMedicines(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const { search, category, page, limit } = req.query as any;
    const data = await pharmacyService.listMedicines(hospitalId, {
      search,
      category,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getMedicine(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.getMedicine(req.params.medicineId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function createMedicine(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.createMedicine(hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function updateMedicine(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.updateMedicine(req.params.medicineId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function deleteMedicine(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.deleteMedicine(req.params.medicineId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

// ── Stock ─────────────────────────────────────────────────────────────────────

export async function receiveStock(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const userId = (req as any).user.id;
    const data = await pharmacyService.receiveStock(hospitalId, userId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function getStockOverview(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.getStockOverview(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getLowStock(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.getLowStockMedicines(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getExpiringBatches(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const days = req.query.days ? parseInt(req.query.days as string) : 90;
    const data = await pharmacyService.getExpiringBatches(hospitalId, days);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function adjustStock(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const userId = (req as any).user.id;
    const data = await pharmacyService.adjustStock(hospitalId, userId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getStockMovements(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const { medicineId, type, page, limit } = req.query as any;
    const data = await pharmacyService.getStockMovements(hospitalId, {
      medicineId,
      type,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getDashboardStats(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await pharmacyService.getDashboardStats(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}
