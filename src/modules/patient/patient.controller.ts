import { Request, Response, NextFunction } from 'express';
import { PatientService } from './patient.service';
import ResponseHandler from '../../common/utils/response';
import { asyncHandler } from '../../common/middleware/errorHandler';

export class PatientController {
  private patientService: PatientService;

  constructor() {
    this.patientService = new PatientService();
  }

  createPatient = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const result = await this.patientService.createPatient(req.body);
      ResponseHandler.success(res, result.message, result.data, 201);
    }
  );

  getPatientById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.patientService.getPatientById(id);
      ResponseHandler.success(res, 'Patient fetched successfully', result.data);
    }
  );

  getPatientByUHID = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { uhid } = req.params;
      const result = await this.patientService.getPatientByUHID(uhid);
      ResponseHandler.success(res, 'Patient fetched successfully', result.data);
    }
  );

  updatePatient = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.patientService.updatePatient(id, req.body);
      ResponseHandler.success(res, result.message, result.data);
    }
  );

  searchPatients = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const query = {
        search: req.query.search as string,
        abhaLinked: req.query.abhaLinked === 'true',
        gender: req.query.gender as string,
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 10,
      };
      const result = await this.patientService.searchPatients(query);
      ResponseHandler.success(res, 'Patients fetched successfully', result.data);
    }
  );

  deletePatient = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction) => {
      const { id } = req.params;
      const result = await this.patientService.deletePatient(id);
      ResponseHandler.success(res, result.message);
    }
  );

  getPatientStats = asyncHandler(
    async (_req: Request, res: Response, _next: NextFunction) => {
      const result = await this.patientService.getPatientStats();
      ResponseHandler.success(res, 'Patient stats fetched successfully', result.data);
    }
  );
}

export default new PatientController();
