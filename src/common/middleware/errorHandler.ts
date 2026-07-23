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

// Friendly column-name → label so we don't echo raw column names
const FRIENDLY_FIELD: Record<string, string> = {
  email: 'Email',
  username: 'Username',
  mobile: 'Mobile',
  phone: 'Phone',
  uhid: 'UHID',
  abhaId: 'ABHA number',
  abhaNumber: 'ABHA number',
  abhaAddress: 'ABHA address',
  registrationNumber: 'Registration number',
  hipId: 'HIP ID',
  hiuId: 'HIU ID',
  code: 'Hospital code',
  licenseNumber: 'License number',
};

const friendlyFieldsFromMeta = (target: unknown): string => {
  const arr = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  if (arr.length === 0) return 'this value';
  return arr.map((f) => FRIENDLY_FIELD[String(f)] || String(f)).join(', ');
};

/**
 * Map a Prisma known-request error to a safe, user-friendly HTTP status + message.
 * We never leak the raw Prisma string (which can include column names, table names,
 * and SQL details). The original error is still in server logs.
 */
const mapPrismaError = (err: any): { status: number; message: string } => {
  const code = err?.code as string | undefined;
  const meta = err?.meta as Record<string, unknown> | undefined;
  switch (code) {
    case 'P2002': {
      const fields = friendlyFieldsFromMeta(meta?.target);
      return { status: 409, message: `${fields} already exists` };
    }
    case 'P2025':
      return { status: 404, message: 'Resource not found' };
    case 'P2003':
      return { status: 400, message: 'Related record not found or in use' };
    case 'P2014':
      return { status: 400, message: 'Operation would violate a required relation' };
    case 'P2000':
      return { status: 400, message: 'A field value is too long' };
    case 'P2011':
      return { status: 400, message: 'A required field is missing' };
    case 'P2012':
      return { status: 400, message: 'A required value is missing' };
    case 'P2015':
    case 'P2016':
      return { status: 404, message: 'Related record not found' };
    // P2021/P2022 mean the running database is missing a table/column the code
    // expects — a schema-drift / un-applied-migration situation. We surface a
    // distinct 503 so operators immediately see "this is an ops problem, not a
    // user input problem" without leaking the column/table name.
    case 'P2021':
      return {
        status: 503,
        message:
          process.env.NODE_ENV === 'production'
            ? 'Service temporarily unavailable. Please try again shortly.'
            : `Database is missing a table the application expects (run pending migrations).${meta?.table ? ` Missing: ${meta.table}` : ''}`,
      };
    case 'P2022':
      return {
        status: 503,
        message:
          process.env.NODE_ENV === 'production'
            ? 'Service temporarily unavailable. Please try again shortly.'
            : `Database is missing a column the application expects (run pending migrations).${meta?.column ? ` Missing: ${meta.column}` : ''}`,
      };
    default:
      return { status: 500, message: 'A database error occurred. Please try again.' };
  }
};

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  logger.error('Error occurred', {
    error: err.message,
    name: err.name,
    code: (err as any).code,
    meta: (err as any).meta,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: (req as any)?.user?.id,
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

  if (err.name === 'TokenExpiredError') {
    ResponseHandler.unauthorized(res, 'Session expired, please sign in again');
    return;
  }

  if (
    err.name === 'PrismaClientKnownRequestError' ||
    (err as any)?.code?.startsWith?.('P')
  ) {
    const { status, message } = mapPrismaError(err);
    ResponseHandler.error(res, message, err.stack, status);
    return;
  }

  if (
    err.name === 'PrismaClientValidationError' ||
    err.name === 'PrismaClientInitializationError'
  ) {
    ResponseHandler.error(res, 'Invalid data submitted', err.stack, 400);
    return;
  }

  ResponseHandler.error(res, 'Something went wrong. Please try again.', err.stack, 500);
};

export const notFoundHandler = (req: Request, res: Response): void => {
  ResponseHandler.notFound(res, `Route ${req.originalUrl} not found`);
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
