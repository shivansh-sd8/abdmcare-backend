import { Request, Response } from 'express';
import ipdService from './ipd.service';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

function err(res: Response, error: any, status = 500) {
  const msg = error?.message || 'Internal server error';
  const code = msg.includes('not found') ? 404 : msg.includes('occupied') || msg.includes('already') ? 409 : status;
  res.status(code).json({ success: false, message: msg });
}

// ── Ward ─────────────────────────────────────────────────────────────────────

export async function listWards(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.listWards(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function createWard(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.createWard(hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function updateWard(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.updateWard(req.params.wardId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

// ── Bed ──────────────────────────────────────────────────────────────────────

export async function createBed(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const { bedNumber } = req.body;
    const data = await ipdService.createBed(req.params.wardId, hospitalId, bedNumber);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function updateBedStatus(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.updateBedStatus(req.params.bedId, hospitalId, req.body.status);
    ok(res, data);
  } catch (e) { err(res, e); }
}

// ── Delete (only non-occupied) ───────────────────────────────────────────────

export async function deleteBed(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    await ipdService.deleteBed(req.params.bedId, hospitalId);
    ok(res, { deleted: true });
  } catch (e) { err(res, e); }
}

export async function deleteWard(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    await ipdService.deleteWard(req.params.wardId, hospitalId);
    ok(res, { deleted: true });
  } catch (e) { err(res, e); }
}

// ── Admissions ───────────────────────────────────────────────────────────────

export async function listAdmissions(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const { status, wardId, page, limit } = req.query as any;
    const data = await ipdService.listAdmissions(hospitalId, {
      status,
      wardId,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 25,
    });
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getAdmission(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getAdmissionById(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function admitPatient(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const admittedBy = (req as any).user.name;
    const data = await ipdService.admitPatient(hospitalId, { ...req.body, admittedBy });
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function updateAdmission(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.updateAdmission(req.params.admissionId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function dischargePatient(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const userRole = (req as any).user.role;
    const data = await ipdService.dischargePatient(req.params.admissionId, hospitalId, req.body, userRole);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getWardOverview(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getWardOverview(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

// ── IPD Rounds ────────────────────────────────────────────────────────────────

export async function getAdmissionRounds(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getAdmissionRounds(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function createAdmissionRound(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const user       = (req as any).user;
    // Resolve doctorId: body → JWT claim → DB lookup by email
    let doctorId = req.body.doctorId || user.doctorId;
    if (!doctorId && user.role === 'DOCTOR') {
      const db = (await import('../../common/config/database')).default;
      const doctor = await db.doctor.findFirst({ where: { email: user.email } });
      doctorId = doctor?.id;
    }
    if (!doctorId) {
      res.status(400).json({ success: false, message: 'doctorId required' });
      return;
    }
    const data = await ipdService.createAdmissionRound(
      req.params.admissionId, hospitalId, { ...req.body, doctorId }
    );
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function markDischargeReady(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const userId     = (req as any).user.id;
    const data = await ipdService.markDischargeReady(req.params.admissionId, hospitalId, userId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function applyDiscount(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const approvedBy = (req as any).user.name || (req as any).user.id;
    const data = await ipdService.applyDiscount(req.params.admissionId, hospitalId, {
      ...req.body, approvedBy,
    });
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function collectPayment(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.collectPayment(req.params.admissionId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getAdmissionBill(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getAdmissionBill(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getDischargeSummary(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getDischargeSummary(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

// ── Bed Management (Admin) ──────────────────────────────────────────────────

export async function bulkCreateBeds(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.bulkCreateBeds(req.params.wardId, hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function updateBedDetails(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.updateBedDetails(req.params.bedId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function transferBed(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const transferredBy = (req as any).user.name || (req as any).user.id;
    const data = await ipdService.transferBed(hospitalId, { ...req.body, transferredBy });
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
}

export async function getTransferHistory(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getTransferHistory(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}

export async function getBedAnalytics(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getBedAnalytics(hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}
