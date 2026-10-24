import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { Platform } from '@prisma/client';
import { getParam } from '../utils/request';

export class NotificationController {
  /**
   * Register or update client device token for targeted push notifications.
   */
  static async registerToken(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, platform } = req.body;
      const userPayload = req.user!;

      if (!token || !platform || !Object.values(Platform).includes(platform)) {
        res.status(400).json({
          success: false,
          message: 'Valid token and platform (ANDROID, IOS, WEB) are required.',
          errorCode: 'MISSING_PARAMETERS',
        });
        return;
      }

      const isCustomer = userPayload.role === 'customer';

      // Upsert device token
      const deviceToken = await prisma.deviceToken.upsert({
        where: { token },
        update: {
          userId: isCustomer ? userPayload.id : null,
          adminUserId: !isCustomer ? userPayload.id : null,
          platform: platform as Platform,
          updatedAt: new Date(),
        },
        create: {
          token,
          platform: platform as Platform,
          userId: isCustomer ? userPayload.id : null,
          adminUserId: !isCustomer ? userPayload.id : null,
        },
      });

      res.status(200).json({
        success: true,
        message: 'Device token registered successfully.',
        data: deviceToken,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get authenticated customer's in-app notifications.
   */
  static async getNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const [notifications, totalCount, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.notification.count({
          where: { userId },
        }),
        prisma.notification.count({
          where: { userId, isRead: false },
        }),
      ]);

      res.status(200).json({
        success: true,
        data: notifications,
        meta: {
          totalCount,
          unreadCount,
          limit,
          offset,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get unread notification count for the authenticated customer.
   */
  static async getUnreadCount(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;

      const unreadCount = await prisma.notification.count({
        where: { userId, isRead: false },
      });

      res.status(200).json({
        success: true,
        data: {
          unreadCount,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Mark a single notification as read.
   */
  static async markAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;
      const id = getParam(req, 'id');

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Notification ID is required.',
          errorCode: 'MISSING_NOTIFICATION_ID',
        });
        return;
      }

      const existing = await prisma.notification.findUnique({
        where: { id },
      });

      if (!existing) {
        res.status(404).json({
          success: false,
          message: 'Notification not found.',
          errorCode: 'NOTIFICATION_NOT_FOUND',
        });
        return;
      }

      if (existing.userId !== userId) {
        res.status(403).json({
          success: false,
          message: 'Access denied. You do not own this notification.',
          errorCode: 'FORBIDDEN',
        });
        return;
      }

      const updated = await prisma.notification.update({
        where: { id },
        data: {
          isRead: true,
          updatedAt: new Date(),
        },
      });

      res.status(200).json({
        success: true,
        message: 'Notification marked as read.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Mark all customer notifications as read.
   */
  static async markAllAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.id;

      await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: {
          isRead: true,
          updatedAt: new Date(),
        },
      });

      res.status(200).json({
        success: true,
        message: 'All notifications marked as read.',
      });
    } catch (error) {
      next(error);
    }
  }
}
