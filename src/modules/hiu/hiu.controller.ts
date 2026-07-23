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
      const currentUser = (req as any).user;
      const result = await this.hiuService.requestHealthInformation(req.body, currentUser);
      ResponseHandler.success(res, result.message);
    }
  );

  receiveHealthInformation = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.hiuService.receiveHealthInformation(req.body);
      ResponseHandler.success(res, result.message);
    }
  );

  // Async ack from the gateway after our /cm/request was forwarded to the HIP.
  // The body carries `hiRequest.transactionId` and `response.requestId`; we
  // pin the transactionId on the in-flight ConsentKeyPair so the subsequent
  // /data/notification push (which only knows the transactionId) can resolve
  // its decryption keypair.
  handleHealthInformationOnRequest = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      // Per ABDM contract, callbacks must ACK fast (gateway times out at ~1s)
      // so we 202 immediately and process the mapping after the response.
      const echoRequestId =
        (req.headers['request-id'] as string) ||
        (req.headers['x-request-id'] as string) ||
        (req as any).requestId;
      res.status(202).json({
        message: 'Accepted',
        ...(echoRequestId ? { requestId: echoRequestId } : {}),
      });
      setImmediate(() => {
        this.hiuService.handleHealthInformationOnRequest(req.body).catch(() => undefined);
      });
    }
  );

  getPatientHealthRecords = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { patientId } = req.params;
      const currentUser = (req as any).user;
      const result = await this.hiuService.getPatientHealthRecords(patientId, currentUser);
      ResponseHandler.success(res, 'Health records fetched successfully', result.data);
    }
  );
}

export default new HiuController();
