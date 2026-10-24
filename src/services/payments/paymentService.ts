import { randomUUID } from 'crypto';
import { Order, OrderStatus, PaymentMethod, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { AppError } from '../../utils/errors';
import { fromPaise, toPaise } from '../../utils/money';
import { logEvent } from '../../utils/logger';
import { claimOrderStatus, restoreOrderStock } from '../inventoryService';
import { NotificationService } from '../notificationService';
import { loadFareSettings } from '../pricingService';
import {
  CashfreeApiError,
  CashfreeClient,
  CashfreeEnvironment,
  CashfreePayment,
  CashfreeRefund,
  getCashfreeConfig,
  PAYMENT_UNAVAILABLE,
} from './cashfreeClient';

/**
 * Online payments with Cashfree (D-020, D-022, docs/CASHFREE_PLAN.md).
 * - The app never decides that an order is paid: only Cashfree's own records (fetched here
 *   with the secret key) or a signed webhook move an order to PAID.
 * - Paid orders stay PLACED until the store confirms (D-022, like cash orders, D-013).
 * - An online order not paid within PAYMENT_WINDOW_MS is cancelled and its stock put back.
 * - When the store cancels a paid order, the refund is started automatically (D-014, D-022).
 */

export const PAYMENT_WINDOW_MS = 15 * 60 * 1000;
export const PROVIDER = 'CASHFREE' as const;

const PAYMENT_ROW = { PENDING: 'PENDING', PAID: 'PAID', FAILED: 'FAILED' } as const;

/** Payment details the app needs to open Cashfree checkout. */
export interface PaymentSession {
  provider: typeof PROVIDER;
  environment: CashfreeEnvironment;
  gatewayOrderId: string;
  paymentSessionId: string;
  payBy: string;
}

export interface PaymentState {
  orderId: string;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  paymentMethod: PaymentMethod;
  /** Latest attempt at the gateway, when not paid: FAILED, USER_DROPPED, PENDING … */
  lastAttemptStatus: string | null;
  lastAttemptMessage: string | null;
  payBy: string | null;
}

export function isOnlinePaymentConfigured(): boolean {
  return getCashfreeConfig() !== null;
}

function cashfree(): CashfreeClient | null {
  const config = getCashfreeConfig();
  return config ? new CashfreeClient(config) : null;
}

export function paymentDeadline(order: Pick<Order, 'createdAt'>): Date {
  return new Date(order.createdAt.getTime() + PAYMENT_WINDOW_MS);
}

const sameAmount = (a: unknown, b: unknown) => toPaise(String(a)) === toPaise(String(b));

function toGatewayFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof CashfreeApiError) {
    logEvent('error', 'cashfree_request_failed', { status: error.status, code: error.code, message: error.message });
    return PAYMENT_UNAVAILABLE();
  }
  return error as AppError;
}

async function loadOwnOnlineOrder(orderId: string, userId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
  if (!order || order.userId !== userId) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (order.paymentMethod !== PaymentMethod.ONLINE) {
    throw new AppError(400, 'NOT_AN_ONLINE_ORDER', 'This order is not paid online.');
  }
  return order;
}

// ---------- Starting a payment ----------

/**
 * Returns a Cashfree payment session for an unpaid online order, creating the Cashfree order
 * the first time. Safe to call again ("Pay again"): the same Cashfree order is reused.
 */
export async function startPayment(orderId: string, userId: string): Promise<PaymentSession> {
  const order = await loadOwnOnlineOrder(orderId, userId);
  if (order.paymentStatus === PaymentStatus.PAID) {
    throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
  }
  const payBy = paymentDeadline(order);
  if (order.orderStatus !== OrderStatus.PLACED || order.paymentStatus !== PaymentStatus.PENDING || payBy.getTime() <= Date.now()) {
    throw new AppError(400, 'PAYMENT_WINDOW_CLOSED', 'This order can no longer be paid. Please place a new order.');
  }

  const client = cashfree();
  if (!client) throw PAYMENT_UNAVAILABLE();

  try {
    const existing = await prisma.payment.findUnique({
      where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: order.id } },
    });

    let cfOrder = existing ? await client.getOrder(order.id) : null;
    if (!cfOrder) {
      try {
        cfOrder = await client.createOrder({
          orderId: order.id,
          amount: Number(order.total),
          customerId: order.userId,
          customerPhone: order.user.phone,
          customerName: order.user.name,
          // Cashfree's own expiry is set later than ours: the expiry job terminates the
          // Cashfree order at our deadline, so a payment can't arrive after we cancel.
          expiresAt: new Date(Math.max(payBy.getTime(), Date.now()) + PAYMENT_WINDOW_MS),
          tags: { store_id: order.storeId, order_number: order.orderNumber },
        });
      } catch (error) {
        // Created by a parallel request (or a retried call): use that one
        if (error instanceof CashfreeApiError && (error.status === 409 || error.code === 'order_already_exists')) {
          cfOrder = await client.getOrder(order.id);
        } else {
          throw error;
        }
      }
      await prisma.payment.upsert({
        where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: order.id } },
        update: {},
        create: { orderId: order.id, provider: PROVIDER, gatewayOrderId: order.id, amount: order.total, status: PAYMENT_ROW.PENDING },
      });
    }

    if (!sameAmount(cfOrder.order_amount, order.total)) {
      logEvent('error', 'cashfree_amount_mismatch', { orderId: order.id });
      throw new AppError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The payment amount does not match the order. Please contact support.');
    }
    if (cfOrder.order_status === 'PAID') {
      await reconcileOrderPayment(order.id);
      throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
    }
    if (cfOrder.order_status !== 'ACTIVE' || !cfOrder.payment_session_id) {
      throw new AppError(400, 'PAYMENT_WINDOW_CLOSED', 'This order can no longer be paid. Please place a new order.');
    }

    return {
      provider: PROVIDER,
      environment: client.environment,
      gatewayOrderId: cfOrder.order_id,
      paymentSessionId: cfOrder.payment_session_id,
      payBy: payBy.toISOString(),
    };
  } catch (error) {
    throw toGatewayFailure(error);
  }
}

// ---------- Checking a payment ----------

function latestAttempt(payments: CashfreePayment[]): CashfreePayment | null {
  if (payments.length === 0) return null;
  return [...payments].sort((a, b) => String(b.payment_time ?? '').localeCompare(String(a.payment_time ?? '')))[0];
}

async function currentState(orderId: string, attempt: CashfreePayment | null = null): Promise<PaymentState> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const unpaidOnline =
    order.paymentMethod === PaymentMethod.ONLINE && order.paymentStatus === PaymentStatus.PENDING && order.orderStatus === OrderStatus.PLACED;
  return {
    orderId: order.id,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    paymentMethod: order.paymentMethod,
    lastAttemptStatus: order.paymentStatus === PaymentStatus.PAID ? null : attempt?.payment_status ?? null,
    lastAttemptMessage: order.paymentStatus === PaymentStatus.PAID ? null : attempt?.payment_message ?? null,
    payBy: unpaidOnline ? paymentDeadline(order).toISOString() : null,
  };
}

/**
 * Brings our order in line with Cashfree's records (used by the status endpoint, the webhook
 * and the expiry job). Marks the order PAID only when Cashfree reports a successful payment
 * of exactly the order total in INR.
 */
export async function reconcileOrderPayment(orderId: string): Promise<PaymentState> {
  const client = cashfree();
  const row = await prisma.payment.findUnique({ where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: orderId } } });
  if (!client || !row) return currentState(orderId);

  const payments = await client.getPayments(orderId);
  const success = payments.find((p) => p.payment_status === 'SUCCESS');
  if (success) {
    await markPaid(orderId, success);
    return currentState(orderId);
  }

  const attempt = latestAttempt(payments);
  if (attempt) {
    await prisma.payment.updateMany({
      where: { id: row.id, status: PAYMENT_ROW.PENDING },
      data: {
        gatewayPaymentId: String(attempt.cf_payment_id),
        paymentMethodDetail: attempt.payment_group ?? null,
        failureReason: attempt.payment_status === 'PENDING' ? null : attempt.payment_message ?? attempt.payment_status,
      },
    });
  }
  return currentState(orderId, attempt);
}

/** Customer status check after the app's checkout callback (never trusts the app's result). */
export async function getPaymentState(orderId: string, userId: string): Promise<PaymentState> {
  await loadOwnOnlineOrder(orderId, userId);
  try {
    return await reconcileOrderPayment(orderId);
  } catch (error) {
    throw toGatewayFailure(error);
  }
}

async function markPaid(orderId: string, payment: CashfreePayment): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const currencyOk = !payment.payment_currency || payment.payment_currency === 'INR';
  if (!currencyOk || !sameAmount(payment.payment_amount, order.total)) {
    logEvent('error', 'cashfree_amount_mismatch', { orderId });
    await prisma.auditLog.create({
      data: { action: 'PAYMENT_AMOUNT_MISMATCH', details: `Order ${order.orderNumber}: gateway reported a different amount; not marked paid.` },
    });
    return;
  }

  const changed = await prisma.$transaction(async (tx) => {
    // Conditional: a webhook and a status check can arrive together; only one marks it paid
    const { count } = await tx.order.updateMany({
      where: { id: orderId, paymentMethod: PaymentMethod.ONLINE, paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
      data: { paymentStatus: PaymentStatus.PAID, updatedAt: new Date() },
    });
    if (count === 0) return false;
    await tx.payment.updateMany({
      where: { orderId, provider: PROVIDER },
      data: {
        status: PAYMENT_ROW.PAID,
        gatewayPaymentId: String(payment.cf_payment_id),
        paymentMethodDetail: payment.payment_group ?? null,
        failureReason: null,
      },
    });
    await tx.auditLog.create({
      data: { action: 'PAYMENT_RECEIVED', details: `Online payment received for order ${order.orderNumber}: ₹${order.total}` },
    });
    return true;
  });
  if (!changed) return;

  NotificationService.sendToUser(order.userId, 'Payment received', `We received ₹${order.total} for order ${order.orderNumber}.`, {
    orderId: order.id,
    orderNumber: order.orderNumber,
  }).catch((err) => logEvent('error', 'payment_notification_failed', { message: (err as Error).message }));

  // Paid for an order that is cancelled now (cancelled at the deadline, or by the store while
  // this payment was being recorded): give the money back. Status is read after the commit.
  await refundIfCancelledAndPaid(orderId, 'Payment received after the order was cancelled');
}

/**
 * Starts the refund when an online order is both cancelled and paid (in either order). Safe to
 * call any number of times; the payment job also calls it as a catch-up.
 */
export async function refundIfCancelledAndPaid(orderId: string, reason: string): Promise<void> {
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (fresh.orderStatus === OrderStatus.CANCELLED && fresh.paymentMethod === PaymentMethod.ONLINE && fresh.paymentStatus === PaymentStatus.PAID) {
    await startRefund(orderId, reason);
  }
}

/** Stops an unpaid order from being paid at Cashfree (store cancelled it). Best effort. */
export async function stopOnlinePayment(orderId: string): Promise<void> {
  const client = cashfree();
  const row = await prisma.payment.findUnique({ where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: orderId } } });
  if (!client || !row) return;
  await client.terminateOrder(orderId).catch(() => undefined);
}

// ---------- Switching to cash ----------

/** COD charge for switching an online order to cash, or a 400 when cash isn't allowed. */
function codChargeForSwitch(fares: Awaited<ReturnType<typeof loadFareSettings>>, fulfillmentType: string, subtotal: number): number {
  if (fulfillmentType === 'PICKUP') return 0;
  const refuse = (code: string) => new AppError(400, code, 'Cash on Delivery is not available for this order.');
  if (!fares.codEnabled) throw refuse('COD_DISABLED');
  if (subtotal < fares.minimumCodOrderAmount) throw refuse('MINIMUM_COD_AMOUNT_NOT_MET');
  if (subtotal > fares.maximumCodOrderAmount) throw refuse('MAXIMUM_COD_AMOUNT_EXCEEDED');
  return fares.codCharge;
}

/**
 * "Pay with cash instead" (D-022): turns an unpaid online order into Cash on Delivery /
 * Pay at Store. The Cashfree order is terminated first so it can't be paid afterwards.
 * Delivery orders get the COD charge and COD rules (D-009); pickup has none (D-018).
 */
export async function switchToCash(orderId: string, userId: string) {
  const order = await loadOwnOnlineOrder(orderId, userId);
  if (order.paymentStatus === PaymentStatus.PAID) {
    throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
  }
  if (order.orderStatus !== OrderStatus.PLACED || order.paymentStatus !== PaymentStatus.PENDING) {
    throw new AppError(400, 'PAYMENT_WINDOW_CLOSED', 'This order can no longer be changed.');
  }

  // Cash rules first: once the Cashfree order is stopped it can't be paid online any more,
  // so a refused switch must not get that far. Only the COD rules apply (D-009); delivery
  // minimum and fee were settled when the order was placed. Pickup has no charge (D-018).
  const codCharge = codChargeForSwitch(await loadFareSettings(prisma), order.fulfillmentType, Number(order.subtotal));

  const client = cashfree();
  const row = await prisma.payment.findUnique({ where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: order.id } } });
  if (row) {
    if (!client) throw PAYMENT_UNAVAILABLE();
    try {
      const state = await reconcileOrderPayment(order.id);
      if (state.paymentStatus === PaymentStatus.PAID) {
        throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
      }
      await client.terminateOrder(order.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Termination refused: it may have just been paid
      const state = await reconcileOrderPayment(order.id).catch(() => null);
      if (state?.paymentStatus === PaymentStatus.PAID) {
        throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
      }
      throw toGatewayFailure(error);
    }
  }

  const total = fromPaise(toPaise(String(order.subtotal)) + toPaise(String(order.deliveryFee)) + toPaise(codCharge) - toPaise(String(order.discount)));

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, paymentMethod: PaymentMethod.ONLINE, paymentStatus: PaymentStatus.PENDING, orderStatus: OrderStatus.PLACED },
      data: { paymentMethod: PaymentMethod.COD, codCharge, total, updatedAt: new Date() },
    });
    if (count === 0) throw new AppError(409, 'ORDER_STATUS_CONFLICT', 'The order changed. Please refresh and try again.');
    await tx.payment.updateMany({
      where: { orderId: order.id, provider: PROVIDER, status: PAYMENT_ROW.PENDING },
      data: { status: PAYMENT_ROW.FAILED, failureReason: 'Customer chose to pay with cash' },
    });
    await tx.auditLog.create({
      data: { action: 'PAYMENT_SWITCHED_TO_CASH', details: `Order ${order.orderNumber} switched from online payment to cash (total ₹${total}).` },
    });
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  });
}

// ---------- Expiry of unpaid online orders ----------

/**
 * Cancels online orders still unpaid PAYMENT_WINDOW_MS after they were placed and puts their
 * stock back (once). Cashfree is asked first, so a payment that arrived late still wins.
 */
export async function expireUnpaidOnlineOrders(now: Date = new Date(), limit = 50): Promise<number> {
  const client = cashfree();
  const due = await prisma.order.findMany({
    where: {
      paymentMethod: PaymentMethod.ONLINE,
      paymentStatus: PaymentStatus.PENDING,
      orderStatus: OrderStatus.PLACED,
      createdAt: { lt: new Date(now.getTime() - PAYMENT_WINDOW_MS) },
      // Without the gateway, orders that reached Cashfree can't be checked: leave them out so
      // they don't block the rest
      ...(client ? {} : { payments: { none: {} } }),
    },
    // Least recently tried first: an order that fails to process moves to the back
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  let cancelled = 0;
  for (const order of due) {
    try {
      const row = await prisma.payment.findUnique({ where: { provider_gatewayOrderId: { provider: PROVIDER, gatewayOrderId: order.id } } });
      if (row && client) {
        await client.terminateOrder(order.id).catch(() => undefined);
        const state = await reconcileOrderPayment(order.id);
        if (state.paymentStatus === PaymentStatus.PAID) continue;
      }

      const done = await prisma.$transaction(async (tx) => {
        try {
          await claimOrderStatus(tx, order.id, OrderStatus.PLACED, OrderStatus.CANCELLED, PaymentStatus.FAILED);
        } catch {
          return false; // changed meanwhile (paid, cancelled by the store …)
        }
        await restoreOrderStock(tx, { orderId: order.id, storeId: order.storeId, reason: `Online payment not completed for order: ${order.orderNumber}` });
        await tx.payment.updateMany({
          where: { orderId: order.id, provider: PROVIDER, status: PAYMENT_ROW.PENDING },
          data: { status: PAYMENT_ROW.FAILED, failureReason: 'Not paid within 15 minutes' },
        });
        await tx.auditLog.create({
          data: { action: 'PAYMENT_EXPIRED', details: `Order ${order.orderNumber} cancelled: online payment not completed within 15 minutes.` },
        });
        return true;
      });
      if (!done) continue;
      cancelled += 1;
      NotificationService.sendToUser(
        order.userId,
        'Order cancelled',
        `Order ${order.orderNumber} was cancelled because the payment was not completed.`,
        { orderId: order.id, orderNumber: order.orderNumber, status: OrderStatus.CANCELLED },
      ).catch(() => undefined);
    } catch (error) {
      logEvent('error', 'payment_expiry_failed', { orderId: order.id, message: (error as Error).message });
      // Rotate it to the back of the queue
      await prisma.order.updateMany({ where: { id: order.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }
  }
  return cancelled;
}

// ---------- Refunds (D-014, D-022) ----------

function applyRefundResult(refundId: string, orderId: string, result: CashfreeRefund) {
  const status: RefundStatus =
    result.refund_status === 'SUCCESS'
      ? RefundStatus.SUCCESS
      : ['FAILED', 'CANCELLED'].includes(result.refund_status)
        ? RefundStatus.FAILED
        : RefundStatus.PENDING;

  return prisma.$transaction(async (tx) => {
    const before = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { order: { select: { orderNumber: true } } } });
    const orderNumber = before.order.orderNumber;
    await tx.refund.update({
      where: { id: refundId },
      data: {
        gatewayRefundId: result.cf_refund_id !== undefined ? String(result.cf_refund_id) : before.gatewayRefundId,
        status,
        failureReason: status === RefundStatus.FAILED ? result.status_description ?? result.refund_status : null,
      },
    });
    if (status === RefundStatus.SUCCESS && before.status !== RefundStatus.SUCCESS) {
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: PaymentStatus.REFUNDED } });
      await tx.auditLog.create({ data: { action: 'REFUND_COMPLETED', details: `Refund of ₹${before.amount} completed for order ${orderNumber}.` } });
      return { completed: true, amount: before.amount };
    }
    if (status === RefundStatus.FAILED && before.status !== RefundStatus.FAILED) {
      await tx.auditLog.create({ data: { action: 'REFUND_FAILED', details: `Refund failed for order ${orderNumber}: ${result.status_description ?? result.refund_status}` } });
    }
    return { completed: false, amount: before.amount };
  });
}

/**
 * Starts the refund of a paid online order (store cancellation, or a payment that arrived
 * after cancellation). Idempotent: one refund per order, and the refund id is sent to
 * Cashfree as the refund_id, so retries can't pay out twice.
 */
export async function startRefund(orderId: string, reason: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.paymentMethod !== PaymentMethod.ONLINE || order.paymentStatus !== PaymentStatus.PAID) return;
  const payment = await prisma.payment.findFirst({ where: { orderId, provider: PROVIDER, status: PAYMENT_ROW.PAID } });
  if (!payment) return;

  let refund;
  try {
    refund = await prisma.refund.create({ data: { orderId, paymentId: payment.id, amount: payment.amount, reason } });
    await prisma.auditLog.create({ data: { action: 'REFUND_STARTED', details: `Refund of ₹${payment.amount} started for order ${order.orderNumber}: ${reason}` } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return; // already started
    throw error;
  }
  await sendRefund(refund.id);
}

async function sendRefund(refundId: string): Promise<void> {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true, order: true } });
  const client = cashfree();
  if (!client) {
    await prisma.refund.update({ where: { id: refundId }, data: { failureReason: 'Payment gateway not configured; will retry' } });
    return;
  }
  try {
    // Look first: an earlier attempt may have reached Cashfree even if its answer was lost
    const gatewayOrderId = refund.payment.gatewayOrderId;
    const existing = await client.getRefund(gatewayOrderId, refund.id).catch((error) => {
      if (error instanceof CashfreeApiError && error.status === 404) return null;
      throw error;
    });
    let result = existing;
    if (!result) {
      try {
        result = await client.createRefund(gatewayOrderId, refund.id, Number(refund.amount), `Order ${refund.order.orderNumber}: ${refund.reason ?? 'order cancelled'}`);
      } catch (error) {
        // Created by a parallel attempt (the payment job and a cancel at the same moment)
        if (error instanceof CashfreeApiError && error.status === 409) {
          result = await client.getRefund(gatewayOrderId, refund.id);
        } else {
          throw error;
        }
      }
    }
    const outcome = await applyRefundResult(refund.id, refund.orderId, result);
    if (outcome.completed) {
      NotificationService.sendToUser(refund.order.userId, 'Refund processed', `Your refund of ₹${outcome.amount} for order ${refund.order.orderNumber} has been processed.`, {
        orderId: refund.orderId,
        orderNumber: refund.order.orderNumber,
      }).catch(() => undefined);
    }
  } catch (error) {
    // Kept PENDING; the payment job retries (same refund_id, so never twice)
    await prisma.refund.update({ where: { id: refundId }, data: { failureReason: (error as Error).message.slice(0, 500) } });
    logEvent('error', 'refund_request_failed', { refundId, message: (error as Error).message });
  }
}

/** Retries refunds that could not be sent and checks pending ones (payment job, webhook). */
export async function syncPendingRefunds(limit = 50): Promise<void> {
  const pending = await prisma.refund.findMany({ where: { status: RefundStatus.PENDING }, orderBy: { createdAt: 'asc' }, take: limit });
  for (const refund of pending) {
    await sendRefund(refund.id).catch(() => undefined);
  }
}

export async function syncRefund(refundId: string): Promise<void> {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } });
  if (refund && refund.status === RefundStatus.PENDING) await sendRefund(refund.id);
}

/**
 * Payment-job safety net (every minute):
 * - cancelled online orders that are paid but have no refund yet (a refund that failed to
 *   start, or a payment recorded while the order was being cancelled) get their refund;
 * - recently cancelled unpaid online orders are checked once more with Cashfree, so a payment
 *   made on an already-open checkout is found (and refunded) even without webhooks.
 */
export async function catchUpCancelledPayments(now: Date = new Date(), limit = 50): Promise<void> {
  const missingRefunds = await prisma.order.findMany({
    where: { paymentMethod: PaymentMethod.ONLINE, orderStatus: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.PAID, refunds: { none: {} } },
    select: { id: true },
    take: limit,
  });
  for (const { id } of missingRefunds) {
    await startRefund(id, 'Order cancelled').catch((err) => logEvent('error', 'refund_catch_up_failed', { orderId: id, message: (err as Error).message }));
  }

  if (!cashfree()) return;
  // Cashfree checkout stays open at most PAYMENT_WINDOW_MS after our deadline
  const since = new Date(now.getTime() - 3 * PAYMENT_WINDOW_MS);
  const recentlyCancelled = await prisma.order.findMany({
    where: {
      paymentMethod: PaymentMethod.ONLINE,
      orderStatus: OrderStatus.CANCELLED,
      paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      createdAt: { gte: since },
      payments: { some: { provider: PROVIDER } },
    },
    select: { id: true },
    take: limit,
  });
  for (const { id } of recentlyCancelled) {
    await reconcileOrderPayment(id).catch((err) => logEvent('error', 'late_payment_check_failed', { orderId: id, message: (err as Error).message }));
  }
}

/**
 * Admin "Retry refund" for a refund Cashfree reported as FAILED. The retry gets a new refund
 * id (Cashfree won't reuse a failed one); still one refund row per order, kept in the audit log.
 */
export async function retryFailedRefund(orderId: string, adminUserId?: string) {
  const refund = await prisma.refund.findUnique({ where: { orderId }, include: { order: { select: { orderNumber: true } } } });
  if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'This order has no refund.');
  if (refund.status !== RefundStatus.FAILED) {
    throw new AppError(400, 'REFUND_NOT_FAILED', 'Only a failed refund can be retried.');
  }
  const retried = await prisma.$transaction(async (tx) => {
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: { id: randomUUID(), status: RefundStatus.PENDING, gatewayRefundId: null, failureReason: null },
    });
    await tx.auditLog.create({
      data: { adminUserId: adminUserId ?? null, action: 'REFUND_RETRIED', details: `Refund of ₹${refund.amount} retried for order ${refund.order.orderNumber} (previous refund id ${refund.id}).` },
    });
    return updated;
  });
  await sendRefund(retried.id);
  return prisma.refund.findUniqueOrThrow({ where: { id: retried.id } });
}
