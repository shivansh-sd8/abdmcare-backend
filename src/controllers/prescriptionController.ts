import { Request, Response, NextFunction } from 'express';
import prescriptionService from '../services/prescriptionService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class PrescriptionController {
  createPrescription = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const prescription = await prescriptionService.createPrescription(req.body);
    ResponseHandler.created(res, 'Prescription created successfully', prescription);
  });

  getAllPrescriptions = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    // Destructure doctorId from query so it doesn't pass through (User.id ≠ Doctor.id)
    const { page, limit, patientId, encounterId, doctorId: _ignored, ...rest } = req.query as any;
    const filters: any = {
      ...rest,
      page:  page  ? parseInt(page,  10) : 1,
      limit: limit ? parseInt(limit, 10) : 10,
    };
    if (patientId)   filters.patientId   = patientId;
    if (encounterId) filters.encounterId = encounterId;

    // Scope to hospital for all non-SUPER_ADMIN users
    if (user.role !== 'SUPER_ADMIN' && user.hospitalId) {
      filters.hospitalId = user.hospitalId;
    }

    const result = await prescriptionService.getAllPrescriptions(filters);
    ResponseHandler.success(res, 'Prescriptions retrieved successfully', result);
  });

  getPrescriptionById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const prescription = await prescriptionService.getPrescriptionById(req.params.id, currentUser);
    ResponseHandler.success(res, 'Prescription retrieved successfully', prescription);
  });

  updatePrescription = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const prescription = await prescriptionService.updatePrescription(req.params.id, req.body, currentUser);
    ResponseHandler.success(res, 'Prescription updated successfully', prescription);
  });

  deletePrescription = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const result = await prescriptionService.deletePrescription(req.params.id, currentUser);
    ResponseHandler.success(res, result.message);
  });

  dispensePrescription = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const currentUser = (req as any).user;
    const result = await prescriptionService.dispensePrescription(
      req.params.id,
      { ...req.body, dispensedBy: currentUser.id },
      currentUser
    );
    ResponseHandler.success(res, 'Prescription dispensed successfully', result);
  });
}

export default new PrescriptionController();
