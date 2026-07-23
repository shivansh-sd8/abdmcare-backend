import { Request, Response, NextFunction } from 'express';
import ehrService from './ehr.service';
import { asyncHandler } from '../../common/middleware/errorHandler';
import { ResponseHandler } from '../../common/utils/response';
import { getEffectiveHospitalId } from '../../common/utils/scope';

class EhrController {
  getPatientList = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { search } = req.query;
    // Effective hospital: non-SUPER_ADMIN → JWT; SUPER_ADMIN with global
    // "viewing as" scope → that hospital; SUPER_ADMIN unscoped → all hospitals.
    const hospitalId = getEffectiveHospitalId(currentUser);
    const result = await ehrService.getPatientList(hospitalId, search as string);
    ResponseHandler.success(res, 'Patient EHR list retrieved', result);
  });

  getPatientEHR = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { patientId } = req.params;
    const result = await ehrService.getPatientEHR(patientId, currentUser);
    ResponseHandler.success(res, 'Patient EHR timeline retrieved', result);
  });

  getPatientProfile = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const { patientId } = req.params;
    const result = await ehrService.getPatientProfile(patientId, currentUser);
    ResponseHandler.success(res, 'Patient profile retrieved', result);
  });
}

export default new EhrController();
