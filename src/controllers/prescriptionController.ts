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
    const filters: any = { ...req.query };

    if (user.role === 'DOCTOR') {
      filters.doctorId = user.id;
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
}

export default new PrescriptionController();
