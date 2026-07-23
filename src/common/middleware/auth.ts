import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index';
import { AuthenticatedRequest } from '../types/index';
import { AppError } from './errorHandler';
import logger from '../config/logger';

interface JwtPayload {
  id: string;
  email: string;
  role: string;
  hospitalId?: string;
  doctorId?: string;
}

export const authenticate = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      throw new AppError('No token provided', 401);
    }

    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;

    // SUPER_ADMIN can pick a hospital from the global "viewing as" selector;
    // the frontend axios interceptor propagates it as ?hospitalId=<id> on
    // every API call. We promote it onto req.user.scopedHospitalId so all
    // services can transparently scope their queries via the helpers in
    // common/utils/scope.ts. For non-SUPER_ADMIN users the param is ignored
    // — their tenancy is bound by the JWT.
    let scopedHospitalId: string | undefined;
    if (decoded.role === 'SUPER_ADMIN') {
      const fromQuery = (req.query?.hospitalId ?? req.query?.scopeHospitalId) as
        | string
        | string[]
        | undefined;
      if (typeof fromQuery === 'string' && fromQuery.length > 0) {
        scopedHospitalId = fromQuery;
      }
    }

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      hospitalId: decoded.hospitalId,
      doctorId: decoded.doctorId,
      scopedHospitalId,
    };

    logger.debug('User authenticated', { userId: decoded.id, scopedHospitalId });
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('Invalid token', 401));
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('Token expired', 401));
    } else {
      next(error);
    }
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('User not authenticated', 401));
    }

    const userRole = req.user.role.toUpperCase();
    const allowedRoles = roles.map(r => r.toUpperCase());

    if (!allowedRoles.includes(userRole)) {
      return next(new AppError('Insufficient permissions', 403));
    }

    next();
  };
};

export const generateToken = (payload: JwtPayload): string => {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions) as string;
};

export const generateRefreshToken = (payload: JwtPayload): string => {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions) as string;
};

export const verifyRefreshToken = (token: string): JwtPayload => {
  return jwt.verify(token, config.jwt.refreshSecret) as JwtPayload;
};
