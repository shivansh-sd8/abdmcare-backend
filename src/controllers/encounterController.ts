import { Request, Response, NextFunction } from 'express';
import encounterService from '../services/encounterService';
import { asyncHandler } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

class EncounterController {
  createEncounter = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const encounter = await encounterService.createEncounter(req.body);
    ResponseHandler.created(res, 'Encounter created successfully', encounter);
  });

  getAllEncounters = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    const filters: any = { ...req.query };

    // Hospital scoping for ADMIN
    if (user.role === 'ADMIN' && user.hospitalId) {
      // Filter by doctors in the same hospital
      filters.hospitalId = user.hospitalId;
    }

    // Doctor can only see their own encounters
    if (user.role === 'DOCTOR') {
      filters.doctorId = user.id;
    }

    const result = await encounterService.getAllEncounters(filters);
    ResponseHandler.success(res, 'Encounters retrieved successfully', result);
  });

  getEncounterById = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const encounter = await encounterService.getEncounterById(req.params.id);
    ResponseHandler.success(res, 'Encounter retrieved successfully', encounter);
  });

  updateEncounter = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const encounter = await encounterService.updateEncounter(req.params.id, req.body);
    ResponseHandler.success(res, 'Encounter updated successfully', encounter);
  });

  completeEncounter = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const { diagnosis, notes } = req.body;
    const encounter = await encounterService.completeEncounter(req.params.id, diagnosis, notes);
    ResponseHandler.success(res, 'Encounter completed successfully', encounter);
  });

  getEncounterStats = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const user = (req as any).user;
    let doctorId = req.query.doctorId as string;

    // Doctor can only see their own stats
    if (user.role === 'DOCTOR') {
      doctorId = user.id;
    }

    const stats = await encounterService.getEncounterStats(doctorId);
    ResponseHandler.success(res, 'Encounter stats retrieved successfully', stats);
  });
}

export default new EncounterController();
