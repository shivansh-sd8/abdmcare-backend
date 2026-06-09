import { Request, Response, NextFunction } from 'express';
import prisma from '../common/config/database';
import { AppError } from '../common/middleware/errorHandler';
import ResponseHandler from '../common/utils/response';

export const getNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return next(new AppError('Unauthorized', 401));

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    ResponseHandler.success(res, 'Notifications fetched', notifications);
  } catch (error) {
    next(error);
  }
};

export const markAllAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return next(new AppError('Unauthorized', 401));

    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });

    ResponseHandler.success(res, 'All notifications marked as read');
  } catch (error) {
    next(error);
  }
};

export const markAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;
    if (!userId) return next(new AppError('Unauthorized', 401));

    const notification = await prisma.notification.update({
      where: { id, userId },
      data: { read: true },
    });

    ResponseHandler.success(res, 'Notification marked as read', notification);
  } catch (error) {
    next(error);
  }
};

export const deleteNotification = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;
    if (!userId) return next(new AppError('Unauthorized', 401));

    await prisma.notification.delete({
      where: { id, userId },
    });

    ResponseHandler.success(res, 'Notification deleted');
  } catch (error) {
    next(error);
  }
};
