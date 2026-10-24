import { catchUpCancelledPayments, expireUnpaidOnlineOrders, syncPendingRefunds } from '../services/payments/paymentService';
import { logEvent } from '../utils/logger';

const INTERVAL_MS = 60 * 1000;

/**
 * Every minute: cancel online orders not paid within 15 minutes (stock put back), refund
 * payments that landed on cancelled orders, and retry / check pending refunds. One run at a time. Single API instance (a shared lock is needed
 * before running several instances, P-017).
 */
export function startPaymentJobs(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cancelled = await expireUnpaidOnlineOrders();
      if (cancelled > 0) logEvent('info', 'unpaid_orders_cancelled', { count: cancelled });
      await catchUpCancelledPayments();
      await syncPendingRefunds();
    } catch (error) {
      logEvent('error', 'payment_job_failed', { message: (error as Error).message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
