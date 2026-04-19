import { Request, Response, NextFunction } from 'express';
import { DoctorService } from './doctor.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class DoctorController {
  private doctorService: DoctorService;

  constructor() {
    this.doctorService = new DoctorService();
  }

  createDoctor = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.doctorService.createDoctor(req.body);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  getDoctorById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.doctorService.getDoctorById(id);
      ResponseHandler.success(res, 'Doctor fetched successfully', result.data);
    }
  );

  updateDoctor = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.doctorService.updateDoctor(id, req.body);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  searchDoctors = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const query = {
        search: req.query.search as string,
        specialization: req.query.specialization as string,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 10,
      };
      const result = await this.doctorService.searchDoctors(query);
      ResponseHandler.success(res, 'Doctors fetched successfully', result.data);
    }
  );

  deleteDoctor = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.doctorService.deleteDoctor(id);
      ResponseHandler.success(res, result.message);
    }
  );

  getDoctorStats = asyncHandler(
    async (_req: Request, res: Response, _next: NextFunction) => {
      const result = await this.doctorService.getDoctorStats();
      ResponseHandler.success(res, 'Doctor stats fetched successfully', result.data);
    }
  );
}

export default new DoctorController();
