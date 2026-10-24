import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam } from '../utils/request';
import { validatedBody } from '../middlewares/validate';
import { createStoreHolidaySchema, updateStoreCustomTimingsSchema, updateStoreTimingsSchema } from '../validation/schemas';
import {
  addHoliday,
  getTimingsOverview,
  removeHoliday,
  updateGlobalTimings,
  updateStoreCustomTimings,
} from '../services/storeScheduleService';

/** Store timings, weekly closed days and holidays (D-015, SUPER_ADMIN). Rules live in storeScheduleService. */
export class AdminStoreTimingsController {
  /** GET /admin/store-timings — global timings, per-store overrides and upcoming holidays */
  static async getOverview(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ success: true, data: await getTimingsOverview() });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/store-timings — global timings for all stores */
  static async updateGlobal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await updateGlobalTimings(req.user?.id, validatedBody(res, updateStoreTimingsSchema));
      res.status(200).json({ success: true, message: 'Store timings updated successfully.', data });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/stores/:id/timings — custom timings for one store (or back to global) */
  static async updateStore(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await updateStoreCustomTimings(req.user?.id, getParam(req, 'id'), validatedBody(res, updateStoreCustomTimingsSchema));
      res.status(200).json({ success: true, message: 'Store timings updated successfully.', data });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/store-holidays — holiday for all stores (storeId null) or one store */
  static async addHoliday(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await addHoliday(req.user?.id, validatedBody(res, createStoreHolidaySchema));
      res.status(201).json({ success: true, message: 'Holiday added successfully.', data });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /admin/store-holidays/:id */
  static async removeHoliday(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await removeHoliday(req.user?.id, getParam(req, 'id'));
      res.status(200).json({ success: true, message: 'Holiday removed successfully.' });
    } catch (error) {
      next(error);
    }
  }
}
