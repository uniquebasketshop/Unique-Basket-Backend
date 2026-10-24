import { Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { FulfillmentType, PaymentMethod, PaymentStatus, OrderStatus } from '@prisma/client';
import { NotificationService } from '../services/notificationService';
import { generateNextOrderNumber } from '../utils/orderNumber';
import { withDeliveryAddress } from '../utils/orderAddress';
import { validatedBody } from '../middlewares/validate';
import { createOrderSchema } from '../validation/schemas';
import { loadFareSettings } from '../services/pricingService';
import { assertOrderItems, calculateOrderCharges, reserveOrderLines, resolveFulfillment } from '../services/orderService';
import { getParam } from '../utils/request';
import { isOnlinePaymentConfigured, paymentDeadline, startPayment } from '../services/payments/paymentService';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function findOrderByIdempotencyKey(userId: string, idempotencyKey: string) {
  return prisma.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
}

interface CreatedOrder {
  id: string;
  orderNumber: string;
  fulfillmentType: FulfillmentType;
  subtotal: unknown;
  deliveryFee: unknown;
  codCharge: unknown;
  total: unknown;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
}

/**
 * For an unpaid ONLINE order: the Cashfree checkout session (D-020). When the gateway can't be
 * reached the order still exists and the app asks again via POST /payments/orders/:id/session.
 */
async function paymentFor(order: CreatedOrder & { id: string }, userId: string) {
  if (order.paymentMethod !== 'ONLINE' || order.paymentStatus !== 'PENDING') return {};
  try {
    return { payment: await startPayment(order.id, userId) };
  } catch (error) {
    return { payment: null, paymentErrorCode: (error as { errorCode?: string }).errorCode ?? 'PAYMENT_UNAVAILABLE' };
  }
}

function createdOrderResponse(order: CreatedOrder, message: string, payment: Record<string, unknown> = {}) {
  return {
    success: true,
    message,
    data: {
      ...payment,
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
  };
}

export class OrderController {
  /**
   * Transactional Order Creation and Checkout.
   */
  static async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized.',
        errorCode: 'UNAUTHORIZED',
      });
      return;
    }

    // Request shape validated by validateBody(createOrderSchema): required fields, payment method,
    // and every item has a productId and a positive quantity. Business rules run in the transaction.
    const { fulfillmentType, addressId, storeId, paymentMethod, items } = validatedBody(res, createOrderSchema);

    // Optional Idempotency-Key header: one checkout attempt creates at most one order.
    // A retry with the same key (e.g. after a timeout) returns the order already created.
    const rawKey = req.header('Idempotency-Key');
    const idempotencyKey = rawKey === undefined ? null : rawKey.trim();
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      res.status(400).json({
        success: false,
        message: 'Invalid Idempotency-Key header.',
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
      });
      return;
    }

    try {
      assertOrderItems(items);
      // No gateway configured: an online order could never be paid (D-020)
      if (paymentMethod === 'ONLINE' && !isOnlinePaymentConfigured()) {
        res.status(400).json({
          success: false,
          message: 'Online payment is not available right now. Please choose cash.',
          errorCode: 'ONLINE_PAYMENT_UNAVAILABLE',
        });
        return;
      }

      if (idempotencyKey) {
        const existing = await findOrderByIdempotencyKey(userId, idempotencyKey);
        if (existing) {
          res.status(200).json(createdOrderResponse(existing, 'Order already created.', await paymentFor(existing, userId)));
          return;
        }
      }

      // Execute entire order creation within a database transaction
      const result = await prisma.$transaction(async (tx) => {
        // 1. Fare/COD configuration (D-009, admin-configurable)
        const fares = await loadFareSettings(tx);

        // 2. Which store fulfils the order (nearest in range for DELIVERY, chosen store for PICKUP)
        const { storeId: assignedStoreId, deliveryAddressSnapshot } = await resolveFulfillment(tx, userId, fares, {
          fulfillmentType,
          addressId,
          storeId,
        });

        // 3. Validate items, deduct stock (CAS) and price the lines
        const { lines: orderItemsToCreate, subtotalPaise } = await reserveOrderLines(tx, assignedStoreId, items);

        // 4–5. Delivery minimum/fee and COD rules/charge
        const {
          subtotal,
          deliveryFee: calculatedDeliveryFee,
          codCharge: calculatedCodCharge,
          total: grandTotal,
        } = calculateOrderCharges(fares, fulfillmentType, paymentMethod, subtotalPaise);

        // 6. Generate standardized Order Number (Format: #UB-DDMMYY-XXX)
        const orderNumber = await generateNextOrderNumber(tx);

        // 7. Create Order record
        const order = await tx.order.create({
          data: {
            orderNumber,
            userId,
            storeId: assignedStoreId,
            fulfillmentType: fulfillmentType as FulfillmentType,
            addressId: fulfillmentType === 'DELIVERY' ? addressId : null,
            deliveryAddressSnapshot: fulfillmentType === 'DELIVERY' ? deliveryAddressSnapshot : undefined,
            subtotal,
            deliveryFee: calculatedDeliveryFee,
            codCharge: calculatedCodCharge,
            total: grandTotal,
            paymentMethod: paymentMethod as PaymentMethod,
            paymentStatus: PaymentStatus.PENDING,
            orderStatus: OrderStatus.PLACED,
            idempotencyKey,
          },
        });

        // Create Order Items
        await tx.orderItem.createMany({
          data: orderItemsToCreate.map((item) => ({
            orderId: order.id,
            productId: item.productId,
            productName: item.productName,
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
          })),
        });

        // 8. ONLINE orders start unpaid (PENDING); the Cashfree session is created after the
        //    commit (paymentFor). Unpaid after 15 minutes → cancelled, stock restored (D-022).

        // 9. Delete user cart items since they have checked out
        await tx.cartItem.deleteMany({
          where: { userId },
        });

        // 10. Write audit log
        await tx.auditLog.create({
          data: {
            action: 'CREATE_ORDER',
            details: `Created order: ${orderNumber} for user ID: ${userId}, total: ${grandTotal}`,
          },
        });

        return { order };
      });

      // Asynchronously trigger notification dispatch to assigned store managers
      NotificationService.sendToStoreManagers(
        result.order.storeId,
        'New Order Received',
        `Order ${result.order.orderNumber} for ₹${result.order.total} requires processing.`,
        { orderId: result.order.id, orderNumber: result.order.orderNumber }
      ).catch((err) => console.error('Error sending order notification to managers:', err));

      res.status(201).json(createdOrderResponse(result.order, 'Order created successfully.', await paymentFor(result.order, userId)));
    } catch (error: any) {
      // Same key sent twice at the same time: the other request created the order and this
      // transaction rolled back (unique key), so return that order.
      if (idempotencyKey) {
        const existing = await findOrderByIdempotencyKey(userId, idempotencyKey).catch(() => null);
        if (existing) {
          res.status(200).json(createdOrderResponse(existing, 'Order already created.', await paymentFor(existing, userId)));
          return;
        }
      }

      if (error.message === 'DELIVERY_DISABLED') {
        res.status(400).json({
          success: false,
          message: 'Delivery orders are currently unavailable.',
          errorCode: 'DELIVERY_DISABLED',
        });
        return;
      }

      if (error.message.startsWith('MINIMUM_DELIVERY_AMOUNT_NOT_MET')) {
        const minAmt = error.message.split(':')[1] || '199';
        res.status(400).json({
          success: false,
          message: `Minimum delivery order amount is ₹${minAmt}.`,
          errorCode: 'MINIMUM_DELIVERY_AMOUNT_NOT_MET',
        });
        return;
      }

      if (error.message === 'COD_DISABLED') {
        res.status(400).json({
          success: false,
          message: 'Cash on Delivery is currently unavailable.',
          errorCode: 'COD_DISABLED',
        });
        return;
      }

      if (error.message.startsWith('MINIMUM_COD_AMOUNT_NOT_MET')) {
        const minCod = error.message.split(':')[1] || '100';
        res.status(400).json({
          success: false,
          message: `COD is available only for orders of ₹${minCod} or more.`,
          errorCode: 'MINIMUM_COD_AMOUNT_NOT_MET',
        });
        return;
      }

      if (error.message.startsWith('MAXIMUM_COD_AMOUNT_EXCEEDED')) {
        const maxCod = error.message.split(':')[1] || '5000';
        res.status(400).json({
          success: false,
          message: `COD is available only for orders up to ₹${Number(maxCod).toLocaleString('en-IN')}.`,
          errorCode: 'MAXIMUM_COD_AMOUNT_EXCEEDED',
        });
        return;
      }

      if (error.message === 'NO_DELIVERY_AVAILABLE') {
        res.status(400).json({
          success: false,
          message: 'No delivery available at your location.',
          errorCode: 'NO_DELIVERY_AVAILABLE',
        });
        return;
      }

      if (error.message.startsWith('INSUFFICIENT_STOCK')) {
        const parts = error.message.split(':');
        res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${parts[1]}. Only ${parts[2]} ${parts[3]} available.`,
          errorCode: 'INSUFFICIENT_STOCK',
        });
        return;
      }

      next(error);
    }
  }

  /**
   * Fetch customer order history.
   */
  static async getOrders(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.id;
      
      const orders = await prisma.order.findMany({
        where: { userId },
        include: {
          store: {
            select: { name: true, storeId: true },
          },
          items: {
            include: {
              product: {
                select: { name: true, unit: true, imageUrl: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({
        success: true,
        data: orders,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetch specific order details.
   */
  static async getOrderById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = getParam(req, 'id');
      const userId = req.user?.id;

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          store: {
            // city/phone: shown as the pickup address for Store Pickup orders (D-016)
            select: { name: true, address: true, storeId: true, city: true, phone: true },
          },
          items: {
            include: {
              product: {
                select: { name: true, unit: true, imageUrl: true },
              },
            },
          },
          address: true,
          // Refund state for the customer (amount/status only)
          refunds: { select: { amount: true, status: true, createdAt: true, updatedAt: true } },
        },
      });

      if (!order || (req.user?.role === 'customer' && order.userId !== userId)) {
        res.status(404).json({
          success: false,
          message: 'Order not found.',
          errorCode: 'ORDER_NOT_FOUND',
        });
        return;
      }

      // Enforce store isolation for Store Managers
      if (req.user?.role === 'STORE_MANAGER' && order.storeId !== req.user.storeId) {
        res.status(403).json({
          success: false,
          message: 'Access Denied. You do not have permissions to view orders for another store.',
          errorCode: 'STORE_ACCESS_FORBIDDEN',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          ...withDeliveryAddress(order),
          // Unpaid online order: pay before this time or it is cancelled (D-022)
          paymentDueBy:
            order.paymentMethod === 'ONLINE' && order.paymentStatus === 'PENDING' && order.orderStatus === 'PLACED'
              ? paymentDeadline(order).toISOString()
              : null,
        },
      });
    } catch (error) {
      next(error);
    }
  }

}
