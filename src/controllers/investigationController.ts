import { Request, Response, NextFunction } from 'express';
import investigationService from '../services/investigationService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class InvestigationController {
  createInvestigation = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const data = {
      ...req.body,
      doctorId: user.role === 'DOCTOR' ? user.id : req.body.doctorId,
      hospitalId: user.hospitalId,
    };
    const investigation = await investigationService.createInvestigation(data);
    ResponseHandler.created(res, 'Investigation ordered successfully', investigation);
  });

  getAllInvestigations = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const filters: any = { ...req.query };

    if (user.role === 'ADMIN' && user.hospitalId) {
      filters.hospitalId = user.hospitalId;
    }

    if (user.role === 'DOCTOR') {
      filters.doctorId = user.id;
    }

    const result = await investigationService.getAllInvestigations(filters);
    ResponseHandler.success(res, 'Investigations retrieved successfully', result);
  });

  getInvestigationById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const investigation = await investigationService.getInvestigationById(req.params.id);
    ResponseHandler.success(res, 'Investigation retrieved successfully', investigation);
  });

  updateInvestigationStatus = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { status, results, reportUrl, notes } = req.body;
    const user = (req as any).user;
    
    const investigation = await investigationService.updateInvestigationStatus(
      req.params.id,
      status,
      {
        results,
        reportUrl,
        notes,
        labTechnicianId: user.role === 'LAB_TECHNICIAN' ? user.id : undefined,
      }
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
