import { Request, Response, NextFunction } from 'express';
import { ConsentService } from './consent.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class ConsentController {
  private consentService: ConsentService;

  constructor() {
    this.consentService = new ConsentService();
  }

  createConsentRequest = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.consentService.createConsentRequest(req.body);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  handleConsentNotification = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.consentService.handleConsentNotification(req.body);
      ResponseHandler.success(res, result?.message || 'Consent notification processed');
    }
  );

  fetchConsentArtefact = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.consentService.fetchConsentArtefact(id);
      ResponseHandler.success(res, 'Consent artefact fetched', result.data);
    }
  );

  getPatientConsents = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { patientId } = req.params;
      const result = await this.consentService.getPatientConsents(patientId);
      ResponseHandler.success(res, 'Consents fetched successfully', result.data);
    }
  );

  revokeConsent = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.consentService.revokeConsent(id);
      ResponseHandler.success(res, result.message);
    }
  );

  getAllConsents = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const result = await this.consentService.getAllConsents(currentUser);
      ResponseHandler.success(res, 'Consents fetched successfully', result.data);
    }
  );

  getConsentStats = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const currentUser = (req as any).user;
      const result = await this.consentService.getConsentStats(currentUser);
      ResponseHandler.success(res, 'Consent stats fetched successfully', result.data);
    }
  );
}

export default new ConsentController();
