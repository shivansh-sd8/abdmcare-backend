import { Request, Response, NextFunction } from 'express';
import immunizationService from '../services/immunizationService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class ImmunizationController {
  create = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const created = await immunizationService.createImmunization(req.body, user);
    ResponseHandler.created(res, 'Immunization recorded successfully', created);
  });

  listForPatient = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const list = await immunizationService.listForPatient(req.params.patientId, user);
    ResponseHandler.success(res, 'Immunizations retrieved', list);
  });

  delete = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const result = await immunizationService.deleteImmunization(req.params.id, user);
    ResponseHandler.success(res, result.message);
  });
}

export default new ImmunizationController();
