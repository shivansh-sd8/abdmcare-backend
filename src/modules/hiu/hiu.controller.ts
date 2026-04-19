import { Request, Response, NextFunction } from 'express';
import { HiuService } from './hiu.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class HiuController {
  private hiuService: HiuService;

  constructor() {
    this.hiuService = new HiuService();
  }

  requestHealthInformation = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hiuService.requestHealthInformation(req.body);
      ResponseHandler.success(res, result.message);
    }
  );

  receiveHealthInformation = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hiuService.receiveHealthInformation(req.body);
      ResponseHandler.success(res, result.message);
    }
  );

  getPatientHealthRecords = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { patientId } = req.params;
      const result = await this.hiuService.getPatientHealthRecords(patientId);
      ResponseHandler.success(res, 'Health records fetched successfully', result.data);
    }
  );
}

export default new HiuController();
