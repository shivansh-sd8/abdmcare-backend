import { Request, Response, NextFunction } from 'express';
import { AppointmentService } from './appointment.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class AppointmentController {
  private appointmentService: AppointmentService;

  constructor() {
    this.appointmentService = new AppointmentService();
  }

  createAppointment = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.appointmentService.createAppointment(req.body);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  getAppointmentById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.appointmentService.getAppointmentById(id);
      ResponseHandler.success(res, 'Appointment fetched successfully', result.data);
    }
  );

  updateAppointment = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.appointmentService.updateAppointment(id, req.body);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  searchAppointments = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const query = {
        patientId: req.query.patientId as string,
        doctorId: req.query.doctorId as string,
        status: req.query.status as string,
        date: req.query.date as string,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 10,
      };
      const result = await this.appointmentService.searchAppointments(query);
      ResponseHandler.success(res, 'Appointments fetched successfully', result.data);
    }
  );

  cancelAppointment = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const { reason } = req.body;
      const result = await this.appointmentService.cancelAppointment(id, reason);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  getAppointmentStats = asyncHandler(
    async (_req: Request, res: Response, _next: NextFunction) => {
      const result = await this.appointmentService.getAppointmentStats();
      ResponseHandler.success(res, 'Appointment stats fetched successfully', result.data);
    }
  );
}

export default new AppointmentController();
