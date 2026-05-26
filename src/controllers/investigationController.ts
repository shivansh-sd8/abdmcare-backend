import { Request, Response, NextFunction } from 'express';
import investigationService from '../services/investigationService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class InvestigationController {
  createInvestigation = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    // doctorId must come from req.body (should be Doctor.id, not User.id)
    const data = {
      ...req.body,
      hospitalId: user.hospitalId,
    };
    const investigation = await investigationService.createInvestigation(data);
    ResponseHandler.created(res, 'Investigation ordered successfully', investigation);
  });

  getAllInvestigations = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { page, limit, ...rest } = req.query as any;
    const filters: any = {
      ...rest,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
    };

    const result = await investigationService.getAllInvestigations(filters, currentUser);
    ResponseHandler.success(res, 'Investigations retrieved successfully', result);
  });

  getInvestigationById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const investigation = await investigationService.getInvestigationById(req.params.id, currentUser);
    ResponseHandler.success(res, 'Investigation retrieved successfully', investigation);
  });

  updateInvestigationStatus = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { status, results, reportUrl, notes, amount } = req.body;
    const user = (req as any).user;
    
    const investigation = await investigationService.updateInvestigationStatus(
      req.params.id,
      status,
      {
        results,
        reportUrl,
        notes,
        amount: amount ? parseFloat(amount) : undefined,
        labTechnicianId: user.role === 'LAB_TECHNICIAN' ? user.id : undefined,
      },
      user
    );
    ResponseHandler.success(res, 'Investigation status updated successfully', investigation);
  });

  getInvestigationStats = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user       = (req as any).user;
    const hospitalId = user.hospitalId ?? req.query.hospitalId as string;

    // For DOCTOR role: use doctorId from JWT (set at login) or fall back to DB lookup by email
    let doctorId: string | undefined = user.doctorId ?? (req.query.doctorId as string | undefined);
    if (!doctorId && user.role === 'DOCTOR') {
      const prisma = (await import('../common/config/database')).default;
      const doctor = await prisma.doctor.findFirst({ where: { email: user.email }, select: { id: true } });
      doctorId = doctor?.id;
    }

    const stats = await investigationService.getInvestigationStats(hospitalId, doctorId, user);
    ResponseHandler.success(res, 'Investigation stats retrieved successfully', stats);
  });
}

export default new InvestigationController();
