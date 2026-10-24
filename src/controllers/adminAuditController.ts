import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';

export class AdminAuditController {
  /**
   * List system audit logs with search, action filtering, date filtering, and pagination.
   * Access is strictly restricted to SUPER_ADMIN.
   */
  static async getAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        search,
        action,
        adminUserId,
        startDate,
        endDate,
        page: queryPage,
        limit: queryLimit,
      } = req.query;

      const whereClause: any = {};

      if (action && typeof action === 'string' && action !== 'ALL') {
        whereClause.action = { contains: action.trim(), mode: 'insensitive' };
      }

      if (adminUserId && typeof adminUserId === 'string' && adminUserId !== 'ALL') {
        whereClause.adminUserId = adminUserId;
      }

      if (startDate || endDate) {
        whereClause.createdAt = {};
        if (startDate) {
          whereClause.createdAt.gte = new Date(startDate as string);
        }
        if (endDate) {
          whereClause.createdAt.lte = new Date(endDate as string);
        }
      }

      if (search && typeof search === 'string' && search.trim()) {
        const searchStr = search.trim();
        whereClause.OR = [
          { action: { contains: searchStr, mode: 'insensitive' } },
          { details: { contains: searchStr, mode: 'insensitive' } },
          { adminUser: { name: { contains: searchStr, mode: 'insensitive' } } },
          { adminUser: { email: { contains: searchStr, mode: 'insensitive' } } },
        ];
      }

      const page = queryPage ? parseInt(queryPage as string) : 1;
      const limit = queryLimit ? parseInt(queryLimit as string) : 15;
      const skip = (page - 1) * limit;

      const totalCount = await prisma.auditLog.count({ where: whereClause });

      const auditLogs = await prisma.auditLog.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          adminUser: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      });

      res.status(200).json({
        success: true,
        data: {
          auditLogs,
          pagination: {
            total: totalCount,
            page,
            limit,
            totalPages: Math.ceil(totalCount / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get distinct audit log actions for filter dropdowns.
   */
  static async getAuditActions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const distinctActions = await prisma.auditLog.findMany({
        select: { action: true },
        distinct: ['action'],
        orderBy: { action: 'asc' },
      });

      res.status(200).json({
        success: true,
        data: distinctActions.map((a) => a.action),
      });
    } catch (error) {
      next(error);
    }
  }
}
