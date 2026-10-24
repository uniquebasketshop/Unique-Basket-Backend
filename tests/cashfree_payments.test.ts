import { createHmac } from 'crypto';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { verifyCashfreeWebhookSignature } from '../src/services/payments/cashfreeClient';
import { catchUpCancelledPayments, expireUnpaidOnlineOrders, PAYMENT_WINDOW_MS, syncPendingRefunds } from '../src/services/payments/paymentService';
import { FAKE_CASHFREE_SECRET, FakeCashfree, installFakeCashfree } from './support/fakeCashfree';

/**
 * Cashfree online payments (D-020, D-022): sessions, server-side verification, webhooks,
 * switch to cash, 15-minute expiry with stock release, and automatic refunds.
 */
describe('Cashfree payments', () => {
  const phoneA = '+919888800801';
  const phoneB = '+919888800802';
  const tag = `CF-${Date.now()}`;
  let fake: FakeCashfree;
  let storeId: string;
  let categoryId: string;
  let productId: string; // ₹250 per piece
  let userA: string;
  let tokenA: string;
  let tokenB: string;
  let adminToken: string;
  let managerToken: string;
  let deliveryAddressId: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const stock = async () =>
    Number((await prisma.storeInventory.findUniqueOrThrow({ where: { storeId_productId: { storeId, productId } } })).stockQuantity);

  const placeOnline = async (token = tokenA, extra: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set(as(token))
      .send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'ONLINE', items: [{ productId, quantity: 1 }], ...extra });
    expect(res.statusCode).toEqual(201);
    return res;
  };
  const status = (orderId: string, token = tokenA) => request(app).get(`/api/v1/payments/orders/${orderId}/status`).set(as(token));
  const session = (orderId: string, token = tokenA) => request(app).post(`/api/v1/payments/orders/${orderId}/session`).set(as(token));
  const toCash = (orderId: string, token = tokenA) => request(app).post(`/api/v1/payments/orders/${orderId}/switch-to-cash`).set(as(token));
  const ageOrder = (orderId: string, ms = PAYMENT_WINDOW_MS + 60_000) =>
    prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - ms) } });
  const auditCount = (action: string, contains: string) => prisma.auditLog.count({ where: { action, details: { contains } } });

  const sendWebhook = (payload: unknown, opts: { secret?: string; timestamp?: string; tamper?: boolean } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = opts.timestamp ?? String(Date.now());
    const signature = createHmac('sha256', opts.secret ?? FAKE_CASHFREE_SECRET).update(timestamp + raw).digest('base64');
    return request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-signature', signature)
      .send(opts.tamper ? raw.replace('PAYMENT', 'PAYMENX') : raw);
  };
  const paymentWebhook = (orderId: string) => ({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: orderId }, payment: { payment_status: 'SUCCESS' } } });

  beforeAll(async () => {
    fake = installFakeCashfree();
    storeId = (await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } })).id;
    categoryId = (await prisma.category.create({ data: { name: `${tag} Fruits` } })).id;
    productId = (await prisma.product.create({ data: { name: `${tag} Mango Box`, categoryId, unit: 'PIECE', price: 250 } })).id;
    await prisma.storeInventory.create({ data: { storeId, productId, stockQuantity: 100 } });

    const a = await prisma.user.upsert({ where: { phone: phoneA }, update: {}, create: { phone: phoneA, name: 'Payer A' } });
    const b = await prisma.user.upsert({ where: { phone: phoneB }, update: {}, create: { phone: phoneB, name: 'Payer B' } });
    userA = a.id;
    tokenA = generateAccessToken({ id: a.id, role: 'customer', phone: phoneA });
    tokenB = generateAccessToken({ id: b.id, role: 'customer', phone: phoneB });
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    const manager = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager1@uniquebasket.com' }, include: { managers: true } });
    managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email, storeId: manager.managers[0].storeId });

    deliveryAddressId = (
      await prisma.userAddress.create({
        data: { userId: userA, title: 'Home', addressLine: '1 Road', city: 'Rajkot', state: 'Gujarat', pincode: '360005', latitude: 22.308155, longitude: 70.800705 },
      })
    ).id;
  });

  afterAll(async () => {
    fake.restore();
    const users = await prisma.user.findMany({ where: { phone: { in: [phoneA, phoneB] } }, select: { id: true } });
    const userIds = users.map((u) => u.id);
    const orders = await prisma.order.findMany({ where: { userId: { in: userIds } }, select: { id: true, orderNumber: true } });
    const orderIds = orders.map((o) => o.id);
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    for (const o of orders) await prisma.auditLog.deleteMany({ where: { details: { contains: o.orderNumber } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cartItem.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  describe('creating the Cashfree order', () => {
    it('sends the server total, our order id, safe customer details and the webhook URL', async () => {
      const res = await placeOnline();
      const orderId = res.body.data.order.id;
      const call = fake.requests.find((r) => r.method === 'POST' && r.path === '/orders' && r.body?.order_id === orderId)!;

      expect(call.headers['x-client-id']).toEqual('test_cashfree_app_id');
      expect(call.headers['x-api-version']).toEqual('2023-08-01');
      // No fixed idempotency key: Cashfree keeps keys of failed requests and refuses retries (found in sandbox)
      expect(call.headers['x-idempotency-key']).toBeUndefined();
      expect(call.body).toMatchObject({
        order_amount: 250,
        order_currency: 'INR',
        customer_details: { customer_id: userA, customer_phone: '9888800801' },
        order_meta: { notify_url: 'https://api.test.example/api/v1/payments/webhook/cashfree' },
        order_tags: { store_id: storeId, order_number: res.body.data.order.orderNumber },
      });
      expect(res.body.data.payment).toMatchObject({ provider: 'CASHFREE', environment: 'SANDBOX', paymentSessionId: `session_${orderId}` });
      expect(new Date(res.body.data.payment.payBy).getTime()).toBeGreaterThan(Date.now() + PAYMENT_WINDOW_MS - 60_000);
    });

    it('still creates the order when Cashfree is unreachable; the app asks for the session again', async () => {
      fake.failNext(1);
      const res = await placeOnline();
      expect(res.body.data.payment).toBeNull();
      expect(res.body.data.paymentErrorCode).toEqual('PAYMENT_UNAVAILABLE');

      const retry = await session(res.body.data.order.id);
      expect(retry.statusCode).toEqual(200);
      expect(retry.body.data.payment.paymentSessionId).toEqual(`session_${res.body.data.order.id}`);
    });
    it('Cashfree created the order but the answer was lost: asking again uses that order', async () => {
      fake.loseNextResponse();
      const res = await placeOnline();
      const orderId = res.body.data.order.id;
      expect(res.body.data.payment).toBeNull();
      expect(fake.orders.has(orderId)).toBe(true);

      const retry = await session(orderId);
      expect(retry.statusCode).toEqual(200);
      expect(retry.body.data.payment.paymentSessionId).toEqual(`session_${orderId}`);
      expect(await prisma.payment.count({ where: { orderId } })).toEqual(1);
    });
  });

  describe('session and status endpoints', () => {
    it('reuse the same Cashfree order for "Pay again"', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      const again = await session(orderId);
      expect(again.statusCode).toEqual(200);
      expect(fake.requests.filter((r) => r.method === 'POST' && r.body?.order_id === orderId)).toHaveLength(1);
    });

    it("are only for the customer's own online order", async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      expect((await session(orderId, tokenB)).statusCode).toEqual(404);
      expect((await status(orderId, tokenB)).statusCode).toEqual(404);
      expect((await toCash(orderId, tokenB)).statusCode).toEqual(404);
      expect((await session(orderId, managerToken)).statusCode).toEqual(403);

      const cod = await request(app)
        .post('/api/v1/orders')
        .set(as(tokenA))
        .send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
      expect((await session(cod.body.data.order.id)).body.errorCode).toEqual('NOT_AN_ONLINE_ORDER');
    });

    it('marks the order paid only after Cashfree reports success; the store still confirms (D-022)', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      const before = await status(orderId);
      expect(before.body.data).toMatchObject({ paymentStatus: 'PENDING', orderStatus: 'PLACED', lastAttemptStatus: null });

      fake.pay(orderId, 'SUCCESS');
      const after = await status(orderId);
      expect(after.body.data).toMatchObject({ paymentStatus: 'PAID', orderStatus: 'PLACED', payBy: null });

      const row = await prisma.payment.findFirstOrThrow({ where: { orderId } });
      expect(row).toMatchObject({ status: 'PAID', paymentMethodDetail: 'upi' });
      expect(row.gatewayPaymentId).toBeTruthy();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(await auditCount('PAYMENT_RECEIVED', order.orderNumber)).toEqual(1);

      expect((await session(orderId)).body.errorCode).toEqual('ORDER_ALREADY_PAID');
    });

    it('reports a failed attempt and keeps the order payable', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId, 'FAILED');
      const res = await status(orderId);
      expect(res.body.data).toMatchObject({ paymentStatus: 'PENDING', lastAttemptStatus: 'FAILED', lastAttemptMessage: 'Payment failed at bank' });
      expect(res.body.data.payBy).toBeTruthy();
      expect((await session(orderId)).statusCode).toEqual(200);
    });

    it('does not mark paid when the paid amount differs from the order total', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId, 'SUCCESS', 1);
      const res = await status(orderId);
      expect(res.body.data.paymentStatus).toEqual('PENDING');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(await auditCount('PAYMENT_AMOUNT_MISMATCH', order.orderNumber)).toEqual(1);
    });

    it('shows the pay-by time in the customer order details while unpaid', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      const details = await request(app).get(`/api/v1/orders/${orderId}`).set(as(tokenA));
      expect(details.body.data.paymentDueBy).toBeTruthy();
      fake.pay(orderId);
      await status(orderId);
      const paid = await request(app).get(`/api/v1/orders/${orderId}`).set(as(tokenA));
      expect(paid.body.data.paymentDueBy).toBeNull();
    });
  });

  describe('webhook', () => {
    it('a correctly signed webhook marks the order paid, once', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      expect((await sendWebhook(paymentWebhook(orderId))).statusCode).toEqual(200);
      expect((await sendWebhook(paymentWebhook(orderId))).statusCode).toEqual(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paymentStatus).toEqual('PAID');
      expect(await auditCount('PAYMENT_RECEIVED', order.orderNumber)).toEqual(1);
    });

    it.each([
      ['a wrong secret', { secret: 'not-the-secret' }],
      ['an old timestamp (replay)', { timestamp: String(Date.now() - 10 * 60 * 1000) }],
      ['a changed body', { tamper: true }],
    ])('is rejected with %s and changes nothing', async (_label, opts) => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      const res = await sendWebhook(paymentWebhook(orderId), opts);
      expect(res.statusCode).toEqual(401);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('PENDING');
    });

    it('is rejected without signature headers', async () => {
      const res = await request(app).post('/api/v1/payments/webhook/cashfree').send(paymentWebhook('x'));
      expect(res.statusCode).toEqual(401);
    });

    it('even a signed webhook cannot mark an order paid that Cashfree has not been paid for', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      expect((await sendWebhook(paymentWebhook(orderId))).statusCode).toEqual(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('PENDING');
    });

    it('acknowledges unknown orders without doing anything', async () => {
      expect((await sendWebhook(paymentWebhook('00000000-0000-4000-8000-000000000000'))).statusCode).toEqual(200);
    });
  });

  describe('pay with cash instead', () => {
    it('pickup: becomes Pay at Store with no extra charge; the Cashfree order is terminated', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      const res = await toCash(orderId);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.order).toMatchObject({ paymentMethod: 'COD', codCharge: 0, total: 250, paymentStatus: 'PENDING' });
      expect(fake.orders.get(orderId)!.order_status).toEqual('TERMINATED');
      expect((await session(orderId)).body.errorCode).toEqual('NOT_AN_ONLINE_ORDER');
    });

    it('delivery: becomes Cash on Delivery with the COD charge', async () => {
      const res = await placeOnline(tokenA, { fulfillmentType: 'DELIVERY', storeId: undefined, addressId: deliveryAddressId });
      const order = res.body.data.order;
      const switched = await toCash(order.id);
      expect(switched.statusCode).toEqual(200);
      expect(switched.body.data.order.codCharge).toBeGreaterThan(0);
      expect(switched.body.data.order.total).toEqual(order.total + switched.body.data.order.codCharge);
    });

    it('is refused once the order is paid', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      const res = await toCash(orderId);
      expect(res.statusCode).toEqual(409);
      expect(res.body.errorCode).toEqual('ORDER_ALREADY_PAID');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('PAID');
    });
  });

  describe('unpaid orders expire after 15 minutes (D-022)', () => {
    it('cancels the order, puts the stock back once and terminates the Cashfree order', async () => {
      const before = await stock();
      const orderId = (await placeOnline()).body.data.order.id;
      expect(await stock()).toEqual(before - 1);
      await ageOrder(orderId);

      expect(await expireUnpaidOnlineOrders()).toBeGreaterThanOrEqual(1);
      await expireUnpaidOnlineOrders();

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({ orderStatus: 'CANCELLED', paymentStatus: 'FAILED' });
      expect(await stock()).toEqual(before);
      expect(fake.orders.get(orderId)!.order_status).toEqual('TERMINATED');
      expect(await auditCount('PAYMENT_EXPIRED', order.orderNumber)).toEqual(1);
      expect((await session(orderId)).body.errorCode).toEqual('PAYMENT_WINDOW_CLOSED');
    });

    it('leaves orders that are still inside the 15 minutes', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      await ageOrder(orderId, PAYMENT_WINDOW_MS - 60_000);
      await expireUnpaidOnlineOrders();
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).orderStatus).toEqual('PLACED');
    });

    it('a payment that arrived just before the deadline wins over expiry', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await ageOrder(orderId);
      await expireUnpaidOnlineOrders();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ orderStatus: 'PLACED', paymentStatus: 'PAID' });
    });

    it('a payment that arrives after cancellation is refunded automatically', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      await ageOrder(orderId);
      await expireUnpaidOnlineOrders();
      fake.pay(orderId); // late payment reported by Cashfree
      expect((await sendWebhook(paymentWebhook(orderId))).statusCode).toEqual(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
      expect(order.orderStatus).toEqual('CANCELLED');
      expect(order.paymentStatus).toEqual('REFUNDED');
      expect(order.refunds).toHaveLength(1);
    });
  });

  describe('refunds when the store cancels a paid order (D-014, D-022)', () => {
    const cancel = (orderId: string) =>
      request(app).put(`/api/v1/admin/orders/${orderId}/status`).set(as(adminToken)).send({ status: 'CANCELLED' });

    it('starts the refund automatically and marks the order refunded', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      expect((await cancel(orderId)).statusCode).toEqual(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
      expect(order.paymentStatus).toEqual('REFUNDED');
      expect(order.refunds[0]).toMatchObject({ status: 'SUCCESS' });
      const call = fake.requests.find((r) => r.method === 'POST' && r.path === `/orders/${orderId}/refunds`)!;
      expect(call.body).toMatchObject({ refund_id: order.refunds[0].id, refund_amount: 250 });
      expect(await auditCount('REFUND_COMPLETED', order.orderNumber)).toEqual(1);

      const admin = await request(app).get(`/api/v1/admin/orders/${orderId}`).set(as(adminToken));
      expect(admin.body.data.refunds[0]).toMatchObject({ status: 'SUCCESS' });
      const customer = await request(app).get(`/api/v1/orders/${orderId}`).set(as(tokenA));
      expect(customer.body.data.refunds[0]).toMatchObject({ status: 'SUCCESS' });
    });

    it('a pending refund is completed by the payment job', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      fake.refundOutcome = 'PENDING';
      await cancel(orderId);
      fake.refundOutcome = 'SUCCESS';

      let refund = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(refund.status).toEqual('PENDING');
      fake.refunds.get(refund.id)!.refund_status = 'SUCCESS';
      await syncPendingRefunds();

      refund = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(refund.status).toEqual('SUCCESS');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('REFUNDED');
    });

    it('a refund that could not be sent is retried, and Cashfree gets it only once', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      fake.failNext(1);
      await cancel(orderId);

      let refund = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(refund.status).toEqual('PENDING');
      expect(refund.failureReason).toBeTruthy();

      await syncPendingRefunds();
      await syncPendingRefunds();
      refund = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(refund.status).toEqual('SUCCESS');
      expect([...fake.refunds.values()].filter((r) => r.order_id === orderId)).toHaveLength(1);
    });

    it('a refund that reached Cashfree but whose answer was lost is found, not sent twice', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      // Cashfree creates the refund, but our request sees a network error
      fake.loseNextResponse((method, path) => method === 'POST' && path.endsWith('/refunds'));
      await cancel(orderId);
      expect((await prisma.refund.findUniqueOrThrow({ where: { orderId } })).status).toEqual('PENDING');
      expect([...fake.refunds.values()].filter((r) => r.order_id === orderId)).toHaveLength(1);

      await syncPendingRefunds();
      const refund = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(refund.status).toEqual('SUCCESS');
      expect([...fake.refunds.values()].filter((r) => r.order_id === orderId)).toHaveLength(1);
    });

    it('"Pay with cash" on an order already marked paid says it is paid', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      const res = await toCash(orderId);
      expect(res.statusCode).toEqual(409);
      expect(res.body.errorCode).toEqual('ORDER_ALREADY_PAID');
    });

    it('cancelling an unpaid online order starts no refund', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      await cancel(orderId);
      expect(await prisma.refund.count({ where: { orderId } })).toEqual(0);
    });
  });

  describe('code review fixes', () => {
    const cancelAs = (orderId: string, token = adminToken) =>
      request(app).put(`/api/v1/admin/orders/${orderId}/status`).set(as(token)).send({ status: 'CANCELLED' });
    const withSettings = async (changes: Record<string, number | boolean>, run: () => Promise<void>) => {
      const settings = await prisma.deliverySettings.findFirstOrThrow();
      await prisma.deliverySettings.update({ where: { id: settings.id }, data: changes });
      try {
        await run();
      } finally {
        await prisma.deliverySettings.update({
          where: { id: settings.id },
          data: Object.fromEntries(Object.keys(changes).map((k) => [k, (settings as Record<string, unknown>)[k]])),
        });
      }
    };
    const placeDelivery = () => placeOnline(tokenA, { fulfillmentType: 'DELIVERY', storeId: undefined, addressId: deliveryAddressId });

    it('"Pay with cash" refused by the COD rules leaves the order payable online', async () => {
      const orderId = (await placeDelivery()).body.data.order.id;
      await withSettings({ maximumCodOrderAmount: 100 }, async () => {
        const res = await toCash(orderId);
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toEqual('MAXIMUM_COD_AMOUNT_EXCEEDED');
      });
      expect(fake.orders.get(orderId)!.order_status).toEqual('ACTIVE');
      expect((await session(orderId)).statusCode).toEqual(200);
    });

    it('"Pay with cash" works after the admin raised the delivery minimum (no 500)', async () => {
      const orderId = (await placeDelivery()).body.data.order.id;
      await withSettings({ minimumOrderAmount: 1000 }, async () => {
        const res = await toCash(orderId);
        expect(res.statusCode).toEqual(200);
        expect(res.body.data.order.paymentMethod).toEqual('COD');
      });
    });

    it('store cancelling an unpaid online order stops its Cashfree checkout', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      expect((await cancelAs(orderId)).statusCode).toEqual(200);
      expect(fake.orders.get(orderId)!.order_status).toEqual('TERMINATED');
    });

    it('a payment made on an order the store already cancelled is found and refunded (no webhook)', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      await cancelAs(orderId);
      fake.pay(orderId); // checkout was still open on the phone

      await catchUpCancelledPayments();

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
      expect(order.paymentStatus).toEqual('REFUNDED');
      expect(order.refunds).toHaveLength(1);
      const note = fake.requests.find((r) => r.method === 'POST' && r.path === `/orders/${orderId}/refunds`)!.body!.refund_note;
      expect(note).toContain('after the order was cancelled');
    });

    it('a cancelled + paid order whose refund never started gets one from the catch-up', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      // Simulate the race: cancelled after payment, refund start lost
      await prisma.order.update({ where: { id: orderId }, data: { orderStatus: 'CANCELLED' } });
      expect(await prisma.refund.count({ where: { orderId } })).toEqual(0);

      await catchUpCancelledPayments();
      await catchUpCancelledPayments();

      expect(await prisma.refund.count({ where: { orderId } })).toEqual(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('REFUNDED');
    });

    it('a refund Cashfree failed can be retried by the super admin with a new refund id', async () => {
      const orderId = (await placeOnline()).body.data.order.id;
      fake.pay(orderId);
      await status(orderId);
      fake.refundOutcome = 'FAILED';
      await cancelAs(orderId);
      fake.refundOutcome = 'SUCCESS';
      const failed = await prisma.refund.findUniqueOrThrow({ where: { orderId } });
      expect(failed.status).toEqual('FAILED');
      const storeNote = fake.requests.find((r) => r.method === 'POST' && r.path === `/orders/${orderId}/refunds`)!.body!.refund_note;
      expect(storeNote).toContain('cancelled by the store');

      expect((await request(app).post(`/api/v1/admin/payments/${orderId}/refund/retry`).set(as(managerToken))).statusCode).toEqual(403);
      const retry = await request(app).post(`/api/v1/admin/payments/${orderId}/refund/retry`).set(as(adminToken));
      expect(retry.statusCode).toEqual(200);
      expect(retry.body.data.refund.status).toEqual('SUCCESS');
      expect(retry.body.data.refund.id).not.toEqual(failed.id);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toEqual('REFUNDED');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(await auditCount('REFUND_RETRIED', order.orderNumber)).toEqual(1);

      const again = await request(app).post(`/api/v1/admin/payments/${orderId}/refund/retry`).set(as(adminToken));
      expect(again.body.errorCode).toEqual('REFUND_NOT_FAILED');
    });

    it('without Cashfree keys the expiry job still cancels orders that never reached Cashfree', async () => {
      const reached = (await placeOnline()).body.data.order.id;
      fake.failNext(1);
      const notReached = (await placeOnline()).body.data.order.id;
      expect(await prisma.payment.count({ where: { orderId: notReached } })).toEqual(0);
      await ageOrder(reached);
      await ageOrder(notReached);

      const savedSecret = process.env.CASHFREE_CLIENT_SECRET;
      process.env.CASHFREE_CLIENT_SECRET = '';
      try {
        await expireUnpaidOnlineOrders();
      } finally {
        process.env.CASHFREE_CLIENT_SECRET = savedSecret;
      }
      expect((await prisma.order.findUniqueOrThrow({ where: { id: notReached } })).orderStatus).toEqual('CANCELLED');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: reached } })).orderStatus).toEqual('PLACED');
    });
  });

  describe('settings and signature helper', () => {
    it('delivery settings tell the app whether online payment is available', async () => {
      expect((await request(app).get('/api/v1/customer/delivery-settings')).body.data.onlinePaymentAvailable).toBe(true);
      const saved = process.env.CASHFREE_CLIENT_SECRET;
      delete process.env.CASHFREE_CLIENT_SECRET;
      try {
        expect((await request(app).get('/api/v1/customer/delivery-settings')).body.data.onlinePaymentAvailable).toBe(false);
      } finally {
        process.env.CASHFREE_CLIENT_SECRET = saved;
      }
    });

    it('verifies signatures with millisecond or second timestamps and rejects others', () => {
      const body = '{"a":1}';
      const now = 1_760_000_000_000;
      const sign = (ts: string) => createHmac('sha256', 's').update(ts + body).digest('base64');
      expect(verifyCashfreeWebhookSignature(body, String(now), sign(String(now)), 's', now)).toBe(true);
      expect(verifyCashfreeWebhookSignature(body, String(now / 1000), sign(String(now / 1000)), 's', now)).toBe(true);
      expect(verifyCashfreeWebhookSignature(body, String(now), sign(String(now)), 'other', now)).toBe(false);
      expect(verifyCashfreeWebhookSignature(body, 'abc', sign('abc'), 's', now)).toBe(false);
      expect(verifyCashfreeWebhookSignature(body, undefined, undefined, 's', now)).toBe(false);
    });
  });
});
