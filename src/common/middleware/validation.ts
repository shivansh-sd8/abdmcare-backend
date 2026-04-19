import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import ResponseHandler from '../utils/response';

export const validate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }

  const extractedErrors = errors.array().map((err) => ({
    field: err.type === 'field' ? err.path : 'unknown',
    message: err.msg,
  }));

  ResponseHandler.validationError(res, extractedErrors);
};
