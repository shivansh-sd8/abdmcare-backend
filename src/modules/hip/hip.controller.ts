import { Request, Response, NextFunction } from 'express';
import { HipService } from './hip.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class HipController {
  private hipService: HipService;

  constructor() {
    this.hipService = new HipService();
  }

  // ABDM Gateway callbacks
  discoverCareContexts = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hipService.discoverCareContexts(req.body);
      ResponseHandler.success(res, 'Care contexts discovered', result);
    }
  );

  linkCareContexts = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hipService.linkCareContexts(req.body);
      ResponseHandler.success(res, 'Care contexts linked', result);
    }
  );

  handleHealthInformationRequest = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hipService.handleHealthInformationRequest(req.body);
      ResponseHandler.success(res, result.message, result);
    }
  );

  // Internal APIs
  addCareContexts = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { patientId } = req.params;
      const { careContexts } = req.body;
      const result = await this.hipService.addCareContexts(patientId, careContexts);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );
}

export default new HipController();
