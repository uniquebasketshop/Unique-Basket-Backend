import { Response, NextFunction } from 'express';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';

const COMPLETED_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.PICKED_UP];
const PENDING_STATUSES: OrderStatus[] = [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.PREPARING];

/**
 * P2-07: dashboard metrics computed in the database instead of downloading every order.
 * Store managers only see their own store (store resolved from the DB by `authenticate`).
 */
export class AdminDashboardController {
  static async getSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { role, storeId } = req.user!;
      const scope: Prisma.OrderWhereInput = role === 'STORE_MANAGER' ? { storeId } : {};

      const [totalOrders, pendingOrders, revenueAgg, recentOrders, activeStores] = await Promise.all([
        prisma.order.count({ where: scope }),
        prisma.order.count({ where: { ...scope, orderStatus: { in: PENDING_STATUSES } } }),
        prisma.order.aggregate({
          where: { ...scope, orderStatus: { in: COMPLETED_STATUSES } },
          _sum: { total: true },
        }),
        prisma.order.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            user: { select: { id: true, name: true, phone: true, email: true } },
            store: { select: { id: true, name: true, storeId: true } },
          },
        }),
        role === 'SUPER_ADMIN' ? prisma.store.count({ where: { isActive: true } }) : Promise.resolve(null),
      ]);

      res.status(200).json({
        success: true,
        data: {
          totalOrders,
          pendingOrders,
          revenue: Number(revenueAgg._sum.total ?? 0),
          activeStores,
          recentOrders,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
