import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam } from '../utils/request';
import { parsePagination } from '../utils/pagination';
import { validatedBody } from '../middlewares/validate';
import { createManagerSchema, updateManagerSchema } from '../validation/schemas';
import { createManager, getManager, listManagers, updateManager } from '../services/managerService';

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Store manager management (SUPER_ADMIN only). Thin HTTP layer (P2-01):
 * rules, transactions and audit logging live in services/managerService.
 */
export class AdminManagerController {
  /** GET /admin/managers — search / storeId / isActive filters; paginated when page/limit are given */
  static async listManagers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await listManagers(
        {
          search: queryString(req.query.search),
          storeId: queryString(req.query.storeId),
          isActive: queryString(req.query.isActive),
        },
        parsePagination(req.query),
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/managers — body validated by createManagerSchema */
  static async createManager(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await createManager(req.user?.id, validatedBody(res, createManagerSchema));
      res.status(201).json({ success: true, message: 'Store Manager created successfully.', data });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/managers/:id — body validated by updateManagerSchema */
  static async updateManager(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await updateManager(req.user?.id, getParam(req, 'id'), validatedBody(res, updateManagerSchema));
      res.status(200).json({ success: true, message: 'Store Manager updated successfully.', data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/managers/:id */
  static async getManagerById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ success: true, data: await getManager(getParam(req, 'id')) });
    } catch (error) {
      next(error);
    }
  }
}
