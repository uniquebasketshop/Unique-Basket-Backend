/**
 * In-memory fake of the Cashfree PG API for tests: intercepts global fetch calls to the
 * sandbox host, so no real network request is made. Sets the Cashfree env vars while active.
 */
type Json = Record<string, unknown>;

interface FakeOrder {
  order_id: string;
  cf_order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: string;
  payment_session_id: string;
  customer_details: Json;
  order_tags: Json;
  order_meta: Json;
  order_expiry_time: string;
}

export interface FakeCashfree {
  orders: Map<string, FakeOrder>;
  payments: Map<string, Json[]>;
  refunds: Map<string, Json>;
  requests: { method: string; path: string; headers: Record<string, string>; body?: Json }[];
  /** Records a payment attempt; SUCCESS also marks the Cashfree order PAID. */
  pay(orderId: string, status?: string, amount?: number): void;
  /** Next refund calls report this status (default SUCCESS). */
  refundOutcome: string;
  /** Makes the next n requests fail with a network error (not processed). */
  failNext(n?: number): void;
  /** Processes the next (matching) request at Cashfree but loses the answer (network error after). */
  loseNextResponse(match?: (method: string, path: string) => boolean): void;
  restore(): void;
}

const SECRET = 'test_cashfree_secret_key';
export const FAKE_CASHFREE_SECRET = SECRET;

export function installFakeCashfree(): FakeCashfree {
  const saved = {
    id: process.env.CASHFREE_CLIENT_ID,
    secret: process.env.CASHFREE_CLIENT_SECRET,
    env: process.env.CASHFREE_ENV,
    base: process.env.PUBLIC_API_BASE_URL,
  };
  process.env.CASHFREE_CLIENT_ID = 'test_cashfree_app_id';
  process.env.CASHFREE_CLIENT_SECRET = SECRET;
  process.env.CASHFREE_ENV = 'sandbox';
  process.env.PUBLIC_API_BASE_URL = 'https://api.test.example';

  let failures = 0;
  let loseResponse: ((method: string, path: string) => boolean) | null = null;
  let paySeq = 0;
  const fake: FakeCashfree = {
    orders: new Map(),
    payments: new Map(),
    refunds: new Map(),
    requests: [],
    refundOutcome: 'SUCCESS',
    pay(orderId, status = 'SUCCESS', amount) {
      const order = fake.orders.get(orderId);
      if (!order) throw new Error(`fake Cashfree: unknown order ${orderId}`);
      paySeq += 1;
      const list = fake.payments.get(orderId) ?? [];
      list.push({
        cf_payment_id: 900000 + paySeq,
        order_id: orderId,
        payment_status: status,
        payment_amount: amount ?? order.order_amount,
        payment_currency: 'INR',
        payment_group: 'upi',
        payment_message: status === 'SUCCESS' ? 'Transaction successful' : 'Payment failed at bank',
        payment_time: new Date(Date.now() + paySeq).toISOString(),
      });
      fake.payments.set(orderId, list);
      if (status === 'SUCCESS') order.order_status = 'PAID';
    },
    failNext(n = 1) {
      failures = n;
    },
    loseNextResponse(match = () => true) {
      loseResponse = match;
    },
    restore() {
      global.fetch = realFetch;
      for (const [key, value] of [
        ['CASHFREE_CLIENT_ID', saved.id],
        ['CASHFREE_CLIENT_SECRET', saved.secret],
        ['CASHFREE_ENV', saved.env],
        ['PUBLIC_API_BASE_URL', saved.base],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  // Plain replacement (not jest.spyOn): the Jest config restores spies before every test
  const realFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== 'sandbox.cashfree.com') return realFetch(input, init);

    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/pg/, '');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    fake.requests.push({ method, path, headers, body });

    if (failures > 0) {
      failures -= 1;
      throw new TypeError('fetch failed');
    }
    if (headers['x-client-secret'] !== SECRET) return reply(401, { message: 'authentication Failed', code: 'request_failed' });
    if (loseResponse && loseResponse(method, path)) {
      loseResponse = null;
      await handle(method, parts(path), body);
      throw new TypeError('fetch failed (response lost)');
    }
    return handle(method, parts(path), body);
  }) as typeof fetch;

  const parts = (path: string) => path.split('/').filter(Boolean); // orders, :id, payments|refunds, :refundId

  async function handle(method: string, parts: string[], body?: Json): Promise<Response> {
    if (parts[0] !== 'orders') return reply(404, { message: 'not found' });

    if (method === 'POST' && parts.length === 1) {
      const id = String(body!.order_id);
      if (fake.orders.has(id)) return reply(409, { message: 'order with same id is already present', code: 'order_already_exists' });
      const order: FakeOrder = {
        order_id: id,
        cf_order_id: `cf_${id.slice(0, 8)}`,
        order_amount: Number(body!.order_amount),
        order_currency: String(body!.order_currency),
        order_status: 'ACTIVE',
        payment_session_id: `session_${id}`,
        customer_details: body!.customer_details as Json,
        order_tags: body!.order_tags as Json,
        order_meta: body!.order_meta as Json,
        order_expiry_time: String(body!.order_expiry_time),
      };
      fake.orders.set(id, order);
      return reply(200, order);
    }

    const order = fake.orders.get(decodeURIComponent(parts[1] ?? ''));
    if (!order) return reply(404, { message: 'order not found', code: 'order_not_found' });

    if (parts.length === 2 && method === 'GET') return reply(200, order);
    if (parts.length === 2 && method === 'PATCH') {
      if (order.order_status === 'PAID') return reply(400, { message: 'order is already paid', code: 'order_already_paid' });
      order.order_status = 'TERMINATED';
      return reply(200, order);
    }
    if (parts[2] === 'payments' && method === 'GET') return reply(200, fake.payments.get(order.order_id) ?? []);
    if (parts[2] === 'refunds' && method === 'POST') {
      const refundId = String(body!.refund_id);
      // Like Cashfree: a refund_id can be used once
      if (fake.refunds.has(refundId)) return reply(409, { message: 'refund with this refund_id already exists', code: 'refund_already_exists' });
      const refund = {
        cf_refund_id: `cfr_${refundId.slice(0, 8)}`,
        refund_id: refundId,
        order_id: order.order_id,
        refund_amount: Number(body!.refund_amount),
        refund_status: fake.refundOutcome,
      };
      fake.refunds.set(refundId, refund);
      return reply(200, refund);
    }
    if (parts[2] === 'refunds' && method === 'GET') {
      const refund = fake.refunds.get(decodeURIComponent(parts[3] ?? ''));
      return refund ? reply(200, refund) : reply(404, { message: 'refund not found' });
    }
    return reply(404, { message: 'not found' });
  }

  return fake;
}
