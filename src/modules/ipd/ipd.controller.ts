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
    const data = await ipdService.dischargePatient(req.params.admissionId, hospitalId, req.body);
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
    // Resolve doctorId: if doctor role, look up their doctor record by email
    let doctorId = req.body.doctorId;
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

export async function getAdmissionBill(req: Request, res: Response) {
  try {
    const hospitalId = (req as any).user.hospitalId;
    const data = await ipdService.getAdmissionBill(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { err(res, e); }
}
