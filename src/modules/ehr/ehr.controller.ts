import { Request, Response, NextFunction } from 'express';
import ehrService from './ehr.service';
import { asyncHandler } from '../../common/middleware/errorHandler';
import { ResponseHandler } from '../../common/utils/response';

class EhrController {
  getPatientList = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { search } = req.query;
    const hospitalId = currentUser.role !== 'SUPER_ADMIN' ? currentUser.hospitalId : undefined;
    const result = await ehrService.getPatientList(hospitalId, search as string);
    ResponseHandler.success(res, 'Patient EHR list retrieved', result);
  });

  getPatientEHR = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { patientId } = req.params;
    const result = await ehrService.getPatientEHR(patientId, currentUser);
    ResponseHandler.success(res, 'Patient EHR timeline retrieved', result);
  });
}

export default new EhrController();
