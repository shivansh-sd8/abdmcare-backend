import { Request, Response, NextFunction } from 'express';
import ipdService from './ipd.service';
import { AppError } from '../../common/middleware/errorHandler';

function ok(res: Response, data: any) {
  res.json({ success: true, data });
}

/**
 * Resolve the hospitalId for the current request:
 *  - SUPER_ADMIN: query.hospitalId or body.hospitalId (must be provided)
 *  - everyone else: JWT-bound hospitalId (cannot be overridden)
 */
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

// ── Ward ─────────────────────────────────────────────────────────────────────

export async function listWards(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.listWards(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function createWard(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.createWard(hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function updateWard(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.updateWard(req.params.wardId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

// ── Bed ──────────────────────────────────────────────────────────────────────

export async function createBed(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const { bedNumber } = req.body;
    const data = await ipdService.createBed(req.params.wardId, hospitalId, bedNumber);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function updateBedStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.updateBedStatus(req.params.bedId, hospitalId, req.body.status);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function deleteBed(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    await ipdService.deleteBed(req.params.bedId, hospitalId);
    ok(res, { deleted: true });
  } catch (e) { next(e); }
}

export async function deleteWard(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    await ipdService.deleteWard(req.params.wardId, hospitalId);
    ok(res, { deleted: true });
  } catch (e) { next(e); }
}

// ── Admissions ───────────────────────────────────────────────────────────────

export async function listAdmissions(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const { status, wardId, page, limit } = req.query as any;
    const data = await ipdService.listAdmissions(hospitalId, {
      status,
      wardId,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 25,
    });
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getAdmission(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getAdmissionById(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function admitPatient(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const admittedBy = (req as any).user?.name;
    const data = await ipdService.admitPatient(hospitalId, { ...req.body, admittedBy });
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function updateAdmission(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.updateAdmission(req.params.admissionId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function dischargePatient(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const userRole = (req as any).user?.role;
    const data = await ipdService.dischargePatient(req.params.admissionId, hospitalId, req.body, userRole);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getWardOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getWardOverview(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

// ── IPD Rounds ────────────────────────────────────────────────────────────────

export async function getAdmissionRounds(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getAdmissionRounds(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function createAdmissionRound(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const user       = (req as any).user;
    const role       = user?.role;
    const db = (await import('../../common/config/database')).default;

    let doctorId = req.body.doctorId || user.doctorId;
    if (!doctorId && role === 'DOCTOR') {
      const doctor = await db.doctor.findFirst({ where: { email: user.email } });
      doctorId = doctor?.id;
    }

    // Nurses are allowed to record vitals/observations on an admission — they
    // don't have a doctorId, so we attribute the round encounter to the
    // admission's primary doctor (the one who admitted via OPD encounter, or
    // the most recent doctor of an existing IPD round). This keeps the audit
    // trail and discharge-summary attribution sensible.
    if (!doctorId && role === 'NURSE') {
      const admission = await db.admission.findFirst({
        where:  { id: req.params.admissionId, hospitalId },
        select: {
          encounter: { select: { doctorId: true } },
          rounds:    { select: { doctorId: true }, orderBy: { visitDate: 'desc' }, take: 1 },
        },
      });
      doctorId = admission?.rounds?.[0]?.doctorId || admission?.encounter?.doctorId;
    }

    if (!doctorId) throw new AppError('doctorId is required', 400);

    // Server-side scope-of-practice guard: nurses can record vitals + notes,
    // but cannot prescribe or order labs. Strip those payloads.
    const sanitizedBody: any = { ...req.body, doctorId };
    if (role === 'NURSE') {
      delete sanitizedBody.prescriptions;
      delete sanitizedBody.labOrders;
      sanitizedBody.recordedBy = `Nurse: ${user.name || user.email}`;
    }

    const data = await ipdService.createAdmissionRound(
      req.params.admissionId, hospitalId, sanitizedBody
    );
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function markDischargeReady(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const userId     = (req as any).user?.id;
    const data = await ipdService.markDischargeReady(req.params.admissionId, hospitalId, userId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function applyDiscount(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const approvedBy = (req as any).user?.name || (req as any).user?.id;
    const data = await ipdService.applyDiscount(req.params.admissionId, hospitalId, {
      ...req.body, approvedBy,
    });
    ok(res, data);
  } catch (e) { next(e); }
}

export async function collectPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.collectPayment(req.params.admissionId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getAdmissionBill(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getAdmissionBill(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getDischargeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getDischargeSummary(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

// ── Bed Management (Admin) ──────────────────────────────────────────────────

export async function bulkCreateBeds(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.bulkCreateBeds(req.params.wardId, hospitalId, req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function updateBedDetails(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.updateBedDetails(req.params.bedId, hospitalId, req.body);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function transferBed(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const transferredBy = (req as any).user?.name || (req as any).user?.id;
    const data = await ipdService.transferBed(hospitalId, { ...req.body, transferredBy });
    res.status(201).json({ success: true, data });
  } catch (e) { next(e); }
}

export async function getTransferHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getTransferHistory(req.params.admissionId, hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}

export async function getBedAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const hospitalId = resolveHospitalId(req);
    const data = await ipdService.getBedAnalytics(hospitalId);
    ok(res, data);
  } catch (e) { next(e); }
}
