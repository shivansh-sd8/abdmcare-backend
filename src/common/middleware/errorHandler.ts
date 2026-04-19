import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import ResponseHandler from '../utils/response';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  logger.error('Error occurred', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  if (err instanceof AppError) {
    ResponseHandler.error(res, err.message, err.stack, err.statusCode);
    return;
  }

  if (err.name === 'ValidationError') {
    ResponseHandler.validationError(res, err.message);
    return;
  }

  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    ResponseHandler.unauthorized(res, 'Invalid or expired token');
    return;
  }

  if (err.name === 'PrismaClientKnownRequestError') {
    ResponseHandler.error(res, 'Database error occurred', err.message, 500);
    return;
  }

  ResponseHandler.error(res, 'Internal server error', err.message, 500);
};

export const notFoundHandler = (req: Request, res: Response): void => {
  ResponseHandler.notFound(res, `Route ${req.originalUrl} not found`);
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
