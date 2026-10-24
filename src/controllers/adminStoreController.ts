import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { prisma } from '../config/db';
import { StoreController } from './storeController';
import { getParam } from '../utils/request';
import { validatedBody } from '../middlewares/validate';
import { resolveStoreLocationSchema } from '../validation/schemas';
import { resolveStoreLocation } from '../services/storeLocationService';
import { paginationMeta, parsePagination } from '../utils/pagination';

/**
 * Admin Store Controller – wraps existing StoreController with admin‑specific isolation.
 * Super Admin: full access (list, get, create, update, delete).
 * Store Manager: can only view their assigned store.
 */
export class AdminStoreController {
  /** List stores for admin dashboard */
  static async listStores(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const paging = parsePagination(req.query);

      if (req.user?.role === 'SUPER_ADMIN' && paging) {
        // Paginated admin list with server-side search/status/city filters
        const { search, isActive, city } = req.query;
        const whereClause: any = {};
        if (isActive !== undefined) whereClause.isActive = isActive === 'true';
        if (typeof city === 'string' && city.trim()) whereClause.city = { equals: city.trim(), mode: 'insensitive' };
        if (typeof search === 'string' && search.trim()) {
          const term = search.trim();
          whereClause.OR = [
            { storeId: { contains: term, mode: 'insensitive' } },
            { name: { contains: term, mode: 'insensitive' } },
            { pincode: { contains: term } },
          ];
        }

        const [stores, total, cityRows] = await Promise.all([
          prisma.store.findMany({
            where: whereClause,
            orderBy: [{ storeId: 'asc' }, { id: 'asc' }],
            skip: paging.skip,
            take: paging.limit,
          }),
          prisma.store.count({ where: whereClause }),
          prisma.store.findMany({ select: { city: true }, distinct: ['city'], orderBy: { city: 'asc' } }),
        ]);
        const cities = Array.from(new Set(cityRows.map((r) => r.city.trim()).filter(Boolean)));

        res.status(200).json({
          success: true,
          data: { stores, pagination: paginationMeta(total, paging), cities },
        });
        return;
      }

      if (req.user?.role === 'SUPER_ADMIN') {
        // Delegate to existing controller (handles optional distance query etc.)
        await StoreController.listStores(req as any, res, next);
        return;
      }

      if (req.user?.role === 'STORE_MANAGER') {
        // Store Manager may only see their own store
        const storeId = req.user.storeId;
        if (!storeId) {
          res.status(400).json({ success: false, message: 'Store ID not available for manager.', errorCode: 'MISSING_STORE_ID' });
          return;
        }
        const store = await prisma.store.findUnique({
          where: { id: storeId },
        });
        if (!store) {
          res.status(404).json({ success: false, message: 'Store not found.', errorCode: 'STORE_NOT_FOUND' });
          return;
        }
        // Return as an array to keep response shape consistent with list endpoint
        res.status(200).json({
          success: true,
          data: paging
            ? { stores: paging.skip === 0 ? [store] : [], pagination: paginationMeta(1, paging), cities: [store.city.trim()] }
            : [store],
        });
        return;
      }

      // Fallback – should not happen because middleware restricts roles
      res.status(403).json({ success: false, message: 'Forbidden', errorCode: 'FORBIDDEN_ACCESS' });
    } catch (error) {
      next(error);
    }
  }

  /** Get a single store (admin view) */
  static async getStoreById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');

      if (req.user?.role === 'SUPER_ADMIN') {
        // Super admin can view any store – reuse existing logic
        await StoreController.getStoreById(req as any, res, next);
        return;
      }

      if (req.user?.role === 'STORE_MANAGER') {
        if (req.user.storeId !== id) {
          // Manager trying to access another store
          res.status(403).json({ success: false, message: 'Access denied to this store.', errorCode: 'STORE_ACCESS_FORBIDDEN' });
          return;
        }
        // Use the existing controller – it already returns 404 if not found
        await StoreController.getStoreById(req as any, res, next);
        return;
      }

      res.status(403).json({ success: false, message: 'Forbidden', errorCode: 'FORBIDDEN_ACCESS' });
    } catch (error) {
      next(error);
    }
  }

  /** Create store – Super Admin only (middleware enforces) */
  static async createStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    // Directly delegate to existing StoreController which contains validation and audit logging
    await StoreController.createStore(req as any, res, next);
  }

  /** Update store – Super Admin only */
  static async updateStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    await StoreController.updateStore(req as any, res, next);
  }

  /** POST /admin/stores/resolve-location – coordinates from a pasted Google Maps link or "lat, lng" */
  static async resolveLocation(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { link } = validatedBody(res, resolveStoreLocationSchema);
      const location = await resolveStoreLocation(link);
      res.status(200).json({ success: true, data: location });
    } catch (error) {
      next(error);
    }
  }

  /** Delete (deactivate) store – Super Admin only */
  static async deleteStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    await StoreController.deleteStore(req as any, res, next);
  }
}
