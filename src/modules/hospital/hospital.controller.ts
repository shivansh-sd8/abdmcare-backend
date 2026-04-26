import { Request, Response, NextFunction } from 'express';
import { HospitalService } from './hospital.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class HospitalController {
  private hospitalService: HospitalService;

  constructor() {
    this.hospitalService = new HospitalService();
  }

  // Onboard new hospital (Public endpoint or SUPER_ADMIN only)
  onboardHospital = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hospitalService.onboardHospital(req.body);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  // Get all hospitals (SUPER_ADMIN only)
  getAllHospitals = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const query = {
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 20,
        search: req.query.search as string,
        status: req.query.status as string,
        plan: req.query.plan as string,
      };
      const result = await this.hospitalService.getAllHospitals(query);
      ResponseHandler.success(res, 'Hospitals fetched successfully', result.data);
    }
  );

  // Get hospital by ID
  getHospitalById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const currentUser = (req as any).user;
      const result = await this.hospitalService.getHospitalById(id, currentUser);
      ResponseHandler.success(res, 'Hospital fetched successfully', result.data);
    }
  );

  // Update hospital (SUPER_ADMIN or hospital's own ADMIN)
  updateHospital = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.hospitalService.updateHospital(id, req.body);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  // Update hospital plan (SUPER_ADMIN only)
  updateHospitalPlan = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const { plan, billingCycle } = req.body;
      const result = await this.hospitalService.updateHospitalPlan(id, plan, billingCycle);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  // Get hospital statistics (SUPER_ADMIN only)
  getHospitalStats = asyncHandler(
    async (_req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hospitalService.getHospitalStats();
      ResponseHandler.success(res, 'Hospital stats fetched successfully', result.data);
    }
  );

  // Delete hospital (SUPER_ADMIN only)
  deleteHospital = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.hospitalService.deleteHospital(id);
      ResponseHandler.success(res, result.message, result.data);
    }
  );
}

export default new HospitalController();
