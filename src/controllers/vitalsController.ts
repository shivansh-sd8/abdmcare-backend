import { Request, Response, NextFunction } from 'express';
import vitalsService from '../services/vitalsService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class VitalsController {
  createVitals = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const data = {
      ...req.body,
      recordedBy: user.id,
    };
    const vitals = await vitalsService.createVitals(data);
    ResponseHandler.created(res, 'Vitals recorded successfully', vitals);
  });

  getAllVitals = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const result = await vitalsService.getAllVitals(req.query);
    ResponseHandler.success(res, 'Vitals retrieved successfully', result);
  });

  getVitalsById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const vitals = await vitalsService.getVitalsById(req.params.id);
    ResponseHandler.success(res, 'Vitals retrieved successfully', vitals);
  });

  getLatestVitals = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const vitals = await vitalsService.getLatestVitals(req.params.patientId);
    ResponseHandler.success(res, 'Latest vitals retrieved successfully', vitals);
  });

  updateVitals = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const vitals = await vitalsService.updateVitals(req.params.id, req.body);
    ResponseHandler.success(res, 'Vitals updated successfully', vitals);
  });

  deleteVitals = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const result = await vitalsService.deleteVitals(req.params.id);
    ResponseHandler.success(res, result.message);
  });
}

export default new VitalsController();
