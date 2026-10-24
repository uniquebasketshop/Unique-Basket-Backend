import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../../utils/errors';

/**
 * Minimal Cashfree Payment Gateway client (D-020). Server-side only: the client secret never
 * leaves the backend. Docs: https://www.cashfree.com/docs/api-reference/payments/latest
 *
 * Configuration (backend .env):
 *   CASHFREE_CLIENT_ID      App ID from the Cashfree dashboard (Developers → API Keys)
 *   CASHFREE_CLIENT_SECRET  Secret Key from the same page
 *   CASHFREE_ENV            sandbox | production
 *   CASHFREE_API_VERSION    optional, default 2023-08-01
 *   PUBLIC_API_BASE_URL     public HTTPS base of this API, e.g. https://api.example.com (webhook URL)
 */

export type CashfreeEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface CashfreeConfig {
  clientId: string;
  clientSecret: string;
  environment: CashfreeEnvironment;
  apiVersion: string;
  baseUrl: string;
  notifyUrl?: string;
}

const DEFAULT_API_VERSION = '2023-08-01';
const REQUEST_TIMEOUT_MS = 15_000;

/** Reads the Cashfree settings; null when not configured (online payment then unavailable). */
export function getCashfreeConfig(): CashfreeConfig | null {
  const clientId = process.env.CASHFREE_CLIENT_ID?.trim();
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const environment: CashfreeEnvironment = process.env.CASHFREE_ENV?.trim().toLowerCase() === 'production' ? 'PRODUCTION' : 'SANDBOX';
  const publicBase = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    environment,
    apiVersion: process.env.CASHFREE_API_VERSION?.trim() || DEFAULT_API_VERSION,
    baseUrl: environment === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg',
    // Cashfree only calls HTTPS webhook URLs; without one we rely on the status check + expiry job.
    notifyUrl: publicBase?.startsWith('https://') ? `${publicBase}/api/v1/payments/webhook/cashfree` : undefined,
  };
}

export const PAYMENT_UNAVAILABLE = () =>
  new AppError(503, 'PAYMENT_UNAVAILABLE', 'Online payment is not available right now. Please try again or pay with cash.');

// ---------- API shapes (only the fields we use) ----------

export interface CashfreeOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | string;
  payment_session_id?: string;
  order_expiry_time?: string;
}

export interface CashfreePayment {
  cf_payment_id: string | number;
  order_id: string;
  payment_status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED' | 'CANCELLED' | 'VOID' | 'NOT_ATTEMPTED' | string;
  payment_amount: number;
  payment_currency?: string;
  payment_group?: string;
  payment_message?: string;
  payment_time?: string;
}

export interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  order_id: string;
  refund_amount: number;
  refund_status: 'SUCCESS' | 'PENDING' | 'CANCELLED' | 'ONHOLD' | 'FAILED' | string;
  status_description?: string;
}

export interface CreateCashfreeOrderInput {
  orderId: string;
  amount: number;
  customerId: string;
  customerPhone: string;
  customerName?: string | null;
  expiresAt: Date;
  tags: Record<string, string>;
}

/** Thrown for gateway HTTP errors; `status` is Cashfree's HTTP status (0 = network/timeout). */
export class CashfreeApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = 'CashfreeApiError';
  }
}

export class CashfreeClient {
  constructor(private readonly config: CashfreeConfig) {}

  get environment(): CashfreeEnvironment {
    return this.config.environment;
  }

  /**
   * No fixed x-idempotency-key: Cashfree remembers a key even when the request failed, so a
   * retry with the same key is refused forever. order_id (unique at Cashfree) prevents
   * duplicates; callers look the order up when it already exists.
   */
  createOrder(input: CreateCashfreeOrderInput): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>('POST', '/orders', {
      body: {
        order_id: input.orderId,
        order_amount: input.amount,
        order_currency: 'INR',
        customer_details: {
          // Cashfree allows letters, digits, '_' and '-' only
          customer_id: input.customerId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50),
          customer_phone: input.customerPhone.replace(/^\+91/, ''),
          ...(input.customerName ? { customer_name: input.customerName.slice(0, 100) } : {}),
        },
        order_meta: this.config.notifyUrl ? { notify_url: this.config.notifyUrl } : {},
        order_expiry_time: input.expiresAt.toISOString(),
        order_tags: input.tags,
      },
    });
  }

  getOrder(orderId: string): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>('GET', `/orders/${encodeURIComponent(orderId)}`);
  }

  getPayments(orderId: string): Promise<CashfreePayment[]> {
    return this.request<CashfreePayment[]>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
  }

  /** Stops an unpaid order from being paid (used when switching to cash or on expiry). */
  terminateOrder(orderId: string): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>('PATCH', `/orders/${encodeURIComponent(orderId)}`, {
      body: { order_status: 'TERMINATED' },
    });
  }

  /** refund_id is unique at Cashfree, so the same refund can never be paid out twice (see createOrder on keys). */
  createRefund(orderId: string, refundId: string, amount: number, note: string): Promise<CashfreeRefund> {
    return this.request<CashfreeRefund>('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, {
      body: { refund_id: refundId, refund_amount: amount, refund_note: note.slice(0, 100) },
    });
  }

  getRefund(orderId: string, refundId: string): Promise<CashfreeRefund> {
    return this.request<CashfreeRefund>('GET', `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'x-client-id': this.config.clientId,
      'x-client-secret': this.config.clientSecret,
      'x-api-version': this.config.apiVersion,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['x-idempotency-key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CashfreeApiError(0, 'network_error', `Cashfree request failed: ${(error as Error).message}`);
    }

    const text = await response.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const err = (data ?? {}) as { message?: string; code?: string };
      // Never include request headers (they carry the secret) in errors
      const endpoint = path.replace(/\/[^/]+(?=\/|$)/g, (seg) => (seg === '/orders' || seg === '/payments' || seg === '/refunds' ? seg : '/:id'));
      throw new CashfreeApiError(response.status, err.code, `Cashfree ${method} ${endpoint} failed (${response.status}): ${err.message ?? 'no message'}`);
    }
    return data as T;
  }
}

/**
 * Webhook signature check: Base64(HMAC-SHA256(timestamp + rawBody, client secret)),
 * constant-time compare, and the timestamp must be recent (replay protection).
 */
export function verifyCashfreeWebhookSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now: number = Date.now(),
  maxAgeMs: number = 5 * 60 * 1000,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Cashfree sends milliseconds; accept seconds too
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (Math.abs(now - tsMs) > maxAgeMs) return false;

  const expected = createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
