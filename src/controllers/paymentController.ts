import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { getParam, requireUserId } from '../utils/request';
import { logEvent } from '../utils/logger';
import { getCashfreeConfig, verifyCashfreeWebhookSignature } from '../services/payments/cashfreeClient';
import {
  getPaymentState,
  reconcileOrderPayment,
  startPayment,
  switchToCash,
  syncRefund,
} from '../services/payments/paymentService';
import { prisma } from '../config/db';

/** Customer payment endpoints and the Cashfree webhook (D-020, D-022). */
export class PaymentController {
  /** POST /payments/orders/:orderId/session — session for Cashfree checkout (first try or "Pay again"). */
  static async createSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const session = await startPayment(getParam(req, 'orderId'), requireUserId(req));
      res.status(200).json({ success: true, data: { payment: session } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /payments/orders/:orderId/status — asks Cashfree, updates the order, returns the result. */
  static async getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const state = await getPaymentState(getParam(req, 'orderId'), requireUserId(req));
      res.status(200).json({ success: true, data: state });
    } catch (error) {
      next(error);
    }
  }

  /** POST /payments/orders/:orderId/switch-to-cash — "Pay with cash instead". */
  static async switchToCash(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await switchToCash(getParam(req, 'orderId'), requireUserId(req));
      res.status(200).json({
        success: true,
        message: 'Order switched to cash payment.',
        data: {
          order: {
            id: order.id,
            orderNumber: order.orderNumber,
            fulfillmentType: order.fulfillmentType,
            subtotal: Number(order.subtotal),
            deliveryFee: Number(order.deliveryFee),
            codCharge: Number(order.codCharge),
            total: Number(order.total),
            paymentMethod: order.paymentMethod,
            paymentStatus: order.paymentStatus,
            orderStatus: order.orderStatus,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /payments/webhook/cashfree — public. Only the signature (HMAC with our secret) is
   * trusted, and even then the payload is used only to know *which* order or refund to
   * re-check with Cashfree's API.
   */
  static async cashfreeWebhook(req: Request, res: Response): Promise<void> {
    const config = getCashfreeConfig();
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
    const valid =
      config !== null &&
      verifyCashfreeWebhookSignature(rawBody, req.header('x-webhook-timestamp'), req.header('x-webhook-signature'), config.clientSecret);
    if (!valid) {
      logEvent('warn', 'cashfree_webhook_rejected', { ip: req.ip });
      res.status(401).json({ success: false, message: 'Invalid signature.', errorCode: 'INVALID_WEBHOOK_SIGNATURE' });
      return;
    }

    try {
      const body = req.body as { type?: string; data?: { order?: { order_id?: string }; refund?: { refund_id?: string; order_id?: string } } };
      const type = body?.type ?? '';
      if (type.startsWith('REFUND')) {
        const refundId = body.data?.refund?.refund_id;
        if (refundId) await syncRefund(refundId);
      } else {
        const orderId = body.data?.order?.order_id;
        // Only orders we created at Cashfree; unknown ids are acknowledged and ignored
        if (orderId && (await prisma.payment.findFirst({ where: { gatewayOrderId: orderId } }))) {
          await reconcileOrderPayment(orderId);
        }
      }
      res.status(200).json({ success: true });
    } catch (error) {
      // 5xx makes Cashfree retry the webhook later
      logEvent('error', 'cashfree_webhook_failed', { message: (error as Error).message });
      res.status(500).json({ success: false, message: 'Webhook processing failed.', errorCode: 'WEBHOOK_PROCESSING_FAILED' });
    }
  }
}
