import { Request, Response, NextFunction } from 'express';
import paymentService from '../services/paymentService';
import { AuthenticatedRequest } from '../common/types';
import { getEffectiveHospitalId } from '../common/utils/scope';

class PaymentController {
  async createPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;
      // Enforce hospital isolation: non-SUPER_ADMIN must use their own hospitalId
      let hospitalId = req.body.hospitalId;
      if (currentUser?.role !== 'SUPER_ADMIN' && currentUser?.hospitalId) {
        hospitalId = currentUser.hospitalId;
      }
      const payment = await paymentService.createPayment({
        ...req.body,
        hospitalId,
        createdBy: currentUser?.id,
      });

      return res.status(201).json({
        success: true,
        message: 'Payment created successfully',
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async getAllPayments(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;
      const { patientId, status, startDate, endDate, page, limit } = req.query;

      // Non-SUPER_ADMIN: their JWT hospital. SUPER_ADMIN with global "viewing
      // as" scope: that hospital. SUPER_ADMIN unscoped: explicit query param,
      // or all hospitals if blank.
      const hospitalId = getEffectiveHospitalId(currentUser) || (req.query.hospitalId as string) || undefined;

      const result = await paymentService.getAllPayments({
        hospitalId,
        patientId: patientId as string,
        status: status as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getPaymentById(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = (req as any).user;
      const payment = await paymentService.getPaymentById(req.params.id, currentUser);

      return res.status(200).json({
        success: true,
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async updatePayment(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = (req as any).user;
      const payment = await paymentService.updatePayment(req.params.id, req.body, currentUser);

      return res.status(200).json({
        success: true,
        message: 'Payment updated successfully',
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async markAsPaid(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = (req as any).user;
      const { transactionId } = req.body;
      const payment = await paymentService.markAsPaid(req.params.id, transactionId, currentUser);

      return res.status(200).json({
        success: true,
        message: 'Payment marked as paid',
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async getConsolidatedBilling(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;
      const hospitalId = getEffectiveHospitalId(currentUser) || (req.query.hospitalId as string) || undefined;
      const patientId = req.query.patientId as string;
      const result = await paymentService.getConsolidatedBilling(hospitalId, patientId);
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getPaymentStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;

      // Effective hospital scope (non-SUPER_ADMIN: JWT; SUPER_ADMIN: global
      // "viewing as" scope; unscoped SUPER_ADMIN: explicit param or platform-wide).
      const hospitalId = getEffectiveHospitalId(currentUser) || (req.query.hospitalId as string) || undefined;

      const stats = await paymentService.getPaymentStats(hospitalId);

      return res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new PaymentController();
