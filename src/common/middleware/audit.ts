import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/index';
import prisma from '../config/database';
import logger from '../config/logger';

export const auditLog = (module: string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const originalJson = res.json.bind(res);

    res.json = function (body: any): Response {
      const logData = {
        action: `${req.method} ${req.path}`,
        module,
        userId: req.user?.id || null,
        userType: req.user ? 'ADMIN' : 'SYSTEM',
        resourceType: module,
        resourceId: req.params.id || null,
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
        requestData: {
          body: req.body,
          query: req.query,
          params: req.params,
        },
        responseData: body,
        status: res.statusCode >= 200 && res.statusCode < 300 ? 'SUCCESS' : 'FAILURE',
        errorMessage: body?.error || null,
      };

      prisma.auditLog
        .create({
          data: logData as any,
        })
        .catch((error) => {
          logger.error('Failed to create audit log', error);
        });

      return originalJson(body);
    };

    next();
  };
};
