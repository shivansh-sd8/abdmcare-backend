import { Request, Response, NextFunction } from 'express';
import auditLogService from '../services/auditLogService';

class AuditLogController {
  async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const {
        userId,
        entity,
        action,
        startDate,
        endDate,
        page = 1,
        limit = 50,
      } = req.query;

      const filters = {
        userId: userId as string,
        entity: entity as string,
        action: action as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        page: parseInt(page as string, 10),
        limit: parseInt(limit as string, 10),
      };

      const result = await auditLogService.getAuditLogs(filters);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserActivity(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { userId } = req.params;
      const { limit = 20 } = req.query;

      const activity = await auditLogService.getUserActivity(
        userId,
        parseInt(limit as string, 10)
      );

      return res.status(200).json({
        success: true,
        data: activity,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEntityHistory(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { entity, entityId } = req.params;

      const history = await auditLogService.getEntityHistory(entity, entityId);

      return res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new AuditLogController();
