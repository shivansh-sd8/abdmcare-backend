import { Request, Response, NextFunction } from 'express';
import encounterService from './encounter.service';
import { asyncHandler } from '../../common/middleware/errorHandler';
import { ResponseHandler } from '../../common/utils/response';

class EncounterController {
  getEncounterById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await encounterService.getEncounterById(id, currentUser);
      ResponseHandler.success(res, 'Encounter fetched successfully', result.data);
    }
  );

  getDoctorEncounters = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { doctorId } = req.params;
      const { status, doctorId: queryDoctorId } = req.query;
      const currentUser = (req as any).user;
      
      // Use doctorId from params or query, or fall back to current user's doctorId
      const targetDoctorId = doctorId || (queryDoctorId as string) || currentUser?.doctorId;
      
      const result = await encounterService.getDoctorEncounters(
        targetDoctorId,
        status as string,
        currentUser
      );
      ResponseHandler.success(res, 'Encounters fetched successfully', result.data);
    }
  );

  updateConsultation = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await encounterService.updateConsultation(id, req.body, currentUser);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  completeConsultation = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await encounterService.completeConsultation(id, req.body, currentUser);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  getEncounterFull = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await encounterService.getEncounterFull(id, currentUser);
      ResponseHandler.success(res, 'Full encounter fetched successfully', result.data);
    }
  );

  collectPayment = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const { paymentMethod, paymentCollected, transactionRef } = req.body;
      const result = await encounterService.collectPayment(id, {
        paymentMethod,
        paymentCollected: parseFloat(paymentCollected) || 0,
        transactionRef,
      }, currentUser);
      ResponseHandler.success(res, 'Payment recorded successfully', result);
    }
  );

  applyDiscount = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await encounterService.applyDiscount(id, {
        amount: parseFloat(req.body.amount) || 0,
        reason: req.body.reason,
        approvedBy: currentUser.name || currentUser.id,
      }, currentUser);
      ResponseHandler.success(res, 'Discount applied successfully', result);
    }
  );
}

export default new EncounterController();
