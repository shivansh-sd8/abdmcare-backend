import { Request, Response, NextFunction } from 'express';
import hospitalService from '../services/hospitalService';

class HospitalController {
  async createHospital(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const hospital = await hospitalService.createHospital(req.body);
      return res.status(201).json({
        success: true,
        message: 'Hospital created successfully',
        data: hospital,
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getAllHospitals(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { isActive, search, page, limit } = req.query;
      
      const result = await hospitalService.getAllHospitals({
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        search: search as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getHospitalById(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const hospital = await hospitalService.getHospitalById(req.params.id);
      return res.status(200).json({
        success: true,
        data: hospital,
      });
    } catch (error: any) {
      next(error);
    }
  }

  async updateHospital(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const hospital = await hospitalService.updateHospital(req.params.id, req.body);
      return res.status(200).json({
        success: true,
        message: 'Hospital updated successfully',
        data: hospital,
      });
    } catch (error: any) {
      next(error);
    }
  }

  async deleteHospital(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      await hospitalService.deleteHospital(req.params.id);
      return res.status(200).json({
        success: true,
        message: 'Hospital deleted successfully',
      });
    } catch (error: any) {
      next(error);
    }
  }

  async getHospitalStats(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const stats = await hospitalService.getHospitalStats(req.params.id);
      return res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      next(error);
    }
  }
}

export default new HospitalController();
