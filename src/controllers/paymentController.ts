import { Request, Response, NextFunction } from 'express';
import paymentService from '../services/paymentService';
import { AuthenticatedRequest } from '../common/types';

class PaymentController {
  async createPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;
      const payment = await paymentService.createPayment({
        ...req.body,
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

      // ADMIN sees only their hospital's payments
      let hospitalId = req.query.hospitalId as string;
      if (currentUser?.role === 'ADMIN' && currentUser?.hospitalId) {
        hospitalId = currentUser.hospitalId;
      }

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
      const payment = await paymentService.getPaymentById(req.params.id);

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
      const payment = await paymentService.updatePayment(req.params.id, req.body);

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
      const { transactionId } = req.body;
      const payment = await paymentService.markAsPaid(req.params.id, transactionId);

      return res.status(200).json({
        success: true,
        message: 'Payment marked as paid',
        data: payment,
      });
    } catch (error) {
      next(error);
    }
  }

  async getPaymentStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const currentUser = req.user;

      // ADMIN sees only their hospital's stats
      let hospitalId = req.query.hospitalId as string;
      if (currentUser?.role === 'ADMIN' && currentUser?.hospitalId) {
        hospitalId = currentUser.hospitalId;
      }

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
