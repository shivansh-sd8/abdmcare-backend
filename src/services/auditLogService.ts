import prisma from '../common/config/database';
import { Request } from 'express';

interface AuditLogData {
  userId: string;
  action: string;
  module: string;
  resourceType: string;
  resourceId?: string;
  requestData?: any;
  responseData?: any;
  status: string;
  ipAddress?: string;
  userAgent?: string;
  userType: string;
}

class AuditLogService {
  async createLog(data: AuditLogData): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: data.userId,
          action: data.action,
          module: data.module,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          requestData: data.requestData,
          responseData: data.responseData,
          status: data.status,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          userType: data.userType as any,
        },
      });
    } catch (error) {
      console.error('Failed to create audit log:', error);
    }
  }

  async logAction(
    req: Request,
    action: string,
    module: string,
    resourceType: string,
    resourceId?: string,
    requestData?: any
  ): Promise<void> {
    const userId = (req as any).user?.id;
    if (!userId) return;

    const ipAddress = req.ip || req.socket.remoteAddress;
    const userAgent = req.get('user-agent');

    await this.createLog({
      userId,
      action,
      module,
      resourceType,
      resourceId,
      requestData,
      status: 'SUCCESS',
      ipAddress,
      userAgent,
      userType: 'USER',
    });
  }

  async getAuditLogs(filters: {
    userId?: string;
    module?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
  }) {
    const { userId, module, action, startDate, endDate, page = 1, limit = 50 } = filters;

    const where: any = {};

    if (userId) where.userId = userId;
    if (module) where.module = module;
    if (action) where.action = action;
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = startDate;
      if (endDate) where.timestamp.lte = endDate;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserActivity(userId: string, limit = 20) {
    return prisma.auditLog.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  async getEntityHistory(resourceType: string, resourceId: string) {
    return prisma.auditLog.findMany({
      where: {
        resourceType,
        resourceId,
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });
  }
}

export default new AuditLogService();
