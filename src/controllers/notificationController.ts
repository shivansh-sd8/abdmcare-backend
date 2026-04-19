import { Request, Response } from 'express';
import prisma from '../common/config/database';
import logger from '../common/config/logger';

export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    const notifications = await prisma.notification.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
    });

    res.json({
      success: true,
      data: notifications,
    });
  } catch (error: any) {
    logger.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message,
    });
  }
};

export const markAllAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    await prisma.notification.updateMany({
      where: {
        userId,
        read: false,
      },
      data: {
        read: true,
      },
    });

    res.json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (error: any) {
    logger.error('Mark all as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notifications as read',
      error: error.message,
    });
  }
};

export const markAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    const notification = await prisma.notification.update({
      where: {
        id,
        userId,
      },
      data: {
        read: true,
      },
    });

    res.json({
      success: true,
      data: notification,
    });
  } catch (error: any) {
    logger.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read',
      error: error.message,
    });
  }
};

export const deleteNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id;
    const { id } = req.params;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    await prisma.notification.delete({
      where: {
        id,
        userId,
      },
    });

    res.json({
      success: true,
      message: 'Notification deleted successfully',
    });
  } catch (error: any) {
    logger.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification',
      error: error.message,
    });
  }
};
