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
    const user = (req as any).user;
    const { page, limit, ...rest } = req.query as any;
    const filters: any = {
      ...rest,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
    };

    // All non-SUPER_ADMIN users see only their hospital's data
    if (user.role !== 'SUPER_ADMIN' && user.hospitalId) {
      filters.hospitalId = user.hospitalId;
    }

    const result = await investigationService.getAllInvestigations(filters);
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
    const user = (req as any).user;
    const hospitalId = user.role === 'ADMIN' ? user.hospitalId : req.query.hospitalId as string;
    const doctorId = user.role === 'DOCTOR' ? user.id : req.query.doctorId as string;

    const stats = await investigationService.getInvestigationStats(hospitalId, doctorId);
    ResponseHandler.success(res, 'Investigation stats retrieved successfully', stats);
  });
}

export default new InvestigationController();
