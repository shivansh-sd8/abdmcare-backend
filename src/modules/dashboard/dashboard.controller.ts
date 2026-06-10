import { Request, Response, NextFunction } from 'express';
import dashboardService from './dashboard.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

class DashboardController {
  getDailyTrends = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const days = Number(req.query.days || 7);
      const result = await dashboardService.getDailyTrends(currentUser, days);
      ResponseHandler.success(res, 'Daily trends retrieved', result?.data);
    },
  );

  getTodayHourlyLoad = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const result = await dashboardService.getTodayHourlyLoad(currentUser);
      ResponseHandler.success(res, 'Hourly load retrieved', result?.data);
    },
  );

  getRevenueBySource = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const days = Number(req.query.days || 7);
      const result = await dashboardService.getRevenueBySource(currentUser, days);
      ResponseHandler.success(res, 'Revenue by source retrieved', result?.data);
    },
  );

  getTopDoctors = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const days = Number(req.query.days || 7);
      const limit = Number(req.query.limit || 5);
      const result = await dashboardService.getTopDoctors(currentUser, days, limit);
      ResponseHandler.success(res, 'Top doctors retrieved', result?.data);
    },
  );

  getEncounterStatus = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const days = Number(req.query.days || 7);
      const result = await dashboardService.getEncounterStatus(currentUser, days);
      ResponseHandler.success(res, 'Encounter status retrieved', result?.data);
    },
  );
}

export default new DashboardController();
