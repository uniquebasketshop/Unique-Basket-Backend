import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam } from '../utils/request';
import { validatedBody } from '../middlewares/validate';
import { updateOrderStatusSchema, verifyPickupSchema } from '../validation/schemas';
import {
  AdminActor,
  AdminOrderQuery,
  changeOrderStatus,
  getAdminOrderDetails,
  listAdminOrders,
  verifyPickupHandover,
  checkPickupOrder,
} from '../services/adminOrderService';

const actorOf = (req: AuthenticatedRequest): AdminActor => ({
  id: req.user?.id,
  role: req.user!.role,
  storeId: req.user?.storeId,
});

const queryString = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Admin / store-manager order endpoints. Thin HTTP layer (P2-01): rules, store isolation,
 * transactions and notifications live in services/adminOrderService.
 */
export class AdminOrderController {
  /** GET /admin/orders — search/filter; paginated when page/limit are given */
  static async getOrders(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query: AdminOrderQuery = {
        storeId: queryString(req.query.storeId),
        status: queryString(req.query.status),
        fulfillment: queryString(req.query.fulfillment),
        paymentStatus: queryString(req.query.paymentStatus),
        search: queryString(req.query.search),
        page: queryString(req.query.page),
        limit: queryString(req.query.limit),
      };
      res.status(200).json({ success: true, data: await listAdminOrders(actorOf(req), query) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /admin/orders/:id */
  static async getOrderDetails(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({ success: true, data: await getAdminOrderDetails(actorOf(req), getParam(req, 'id')) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /admin/orders/:id/status — body validated by updateOrderStatusSchema */
  static async updateOrderStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status } = validatedBody(res, updateOrderStatusSchema);
      const updated = await changeOrderStatus(actorOf(req), getParam(req, 'id'), status);
      res.status(200).json({ success: true, message: 'Order status updated successfully.', data: updated });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/orders/pickup-check — shows the pickup order before handover (changes nothing) */
  static async checkPickup(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderNumber, phone } = validatedBody(res, verifyPickupSchema);
      const data = await checkPickupOrder(actorOf(req), orderNumber, phone);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /** POST /admin/orders/pickup-verify — order number + registered phone (D-006) */
  static async verifyPickup(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderNumber, phone } = validatedBody(res, verifyPickupSchema);
      const data = await verifyPickupHandover(actorOf(req), orderNumber, phone);
      res.status(200).json({ success: true, message: 'Handover verified. Order status updated to PICKED_UP.', data });
    } catch (error) {
      next(error);
    }
  }
}
