import { Request, Response, NextFunction } from 'express';
import { AbhaService } from './abha.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class AbhaController {
  private abhaService: AbhaService;

  constructor() {
    this.abhaService = new AbhaService();
  }

  generateAadhaarOtp = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { aadhaar } = req.body;
      const result = await this.abhaService.generateAadhaarOtp({ aadhaar });
      ResponseHandler.success(res, result.message, result);
    }
  );

  verifyAadhaarOtp = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { txnId, otp } = req.body;
      const result = await this.abhaService.verifyAadhaarOtp({ txnId, otp });
      ResponseHandler.success(res, result.message, result);
    }
  );

  createAbha = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { txnId, mobile, email } = req.body;
      const result = await this.abhaService.createAbha({ txnId, mobile, email });
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  getProfile = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { abhaId } = req.params;
      const result = await this.abhaService.getProfile(abhaId);
      ResponseHandler.success(res, 'Profile fetched successfully', result.data);
    }
  );

  getQrCode = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { abhaId } = req.params;
      const result = await this.abhaService.getQrCode(abhaId);
      ResponseHandler.success(res, 'QR code fetched successfully', result.data);
    }
  );

  searchAbha = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const query = req.body;
      const result = await this.abhaService.searchAbha(query);
      ResponseHandler.success(res, 'Search completed successfully', result.data);
    }
  );

  linkToPatient = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { abhaNumber, patientId } = req.body;
      const result = await this.abhaService.linkToPatient(abhaNumber, patientId);
      ResponseHandler.success(res, result.message);
    }
  );
}

export default new AbhaController();
