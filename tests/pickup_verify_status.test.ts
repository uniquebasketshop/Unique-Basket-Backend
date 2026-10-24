import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { OrderStatus, PaymentStatus } from '@prisma/client';

// P0-04: Pickup handover is only allowed from READY_FOR_PICKUP.
describe('Pickup verification status guard (P0-04)', () => {
  const customerPhone = '+919888800004';
  let customerId: string;
  let storeId: string;
  let managerToken: string;
  let seq = 0;

  const createPickupOrder = async (
    orderStatus: OrderStatus,
    paymentStatus: PaymentStatus = PaymentStatus.PENDING,
    paymentMethod: 'COD' | 'ONLINE' = 'COD',
  ) => {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-P004-${Date.now()}-${seq}`,
        userId: customerId,
        storeId,
        fulfillmentType: 'PICKUP',
        subtotal: 100,
        deliveryFee: 0,
        codCharge: 0,
        total: 100,
        paymentMethod,
        paymentStatus,
        orderStatus,
      },
    });
  };

  const verify = (orderNumber: string) =>
    request(app)
      .post('/api/v1/admin/orders/pickup-verify')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ orderNumber, phone: customerPhone });

  const check = (orderNumber: string, phone = customerPhone, token = managerToken) =>
    request(app)
      .post('/api/v1/admin/orders/pickup-check')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNumber, phone });

  beforeAll(async () => {
    const manager = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    if (!manager || manager.managers.length === 0) {
      throw new Error('Seeded manager1 with a store assignment not found.');
    }
    storeId = manager.managers[0].storeId;

    const user = await prisma.user.upsert({
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Pickup Guard Customer' },
    });
    customerId = user.id;

    managerToken = generateAccessToken({
      id: manager.id,
      role: 'STORE_MANAGER',
      email: manager.email,
      storeId,
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  it.each([
    [OrderStatus.PLACED],
    [OrderStatus.CONFIRMED],
    [OrderStatus.PREPARING],
    [OrderStatus.CANCELLED],
    [OrderStatus.PICKED_UP],
  ])('rejects handover for a %s order and leaves it unchanged', async (status) => {
    const order = await createPickupOrder(status);

    const res = await verify(order.orderNumber);

    expect(res.statusCode).toEqual(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('errorCode', 'ORDER_NOT_READY_FOR_PICKUP');

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.orderStatus).toEqual(status);
    expect(after.paymentStatus).toEqual(PaymentStatus.PENDING);
  });

  it('allows handover for a READY_FOR_PICKUP order', async () => {
    const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);

    const res = await verify(order.orderNumber);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveProperty('orderStatus', 'PICKED_UP');
    expect(res.body.data).toHaveProperty('paymentStatus', 'PAID');
  });

  it.each([
    ['without the leading #', (n: string) => n.slice(1)],
    ['in lower case', (n: string) => n.toLowerCase()],
    ['with surrounding spaces', (n: string) => `  ${n.slice(1)}  `],
  ])('finds the order when the number is typed %s', async (_label, typed) => {
    const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);

    const res = await verify(typed(order.orderNumber));

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveProperty('orderStatus', 'PICKED_UP');
  });

  it('hands over only once when verified concurrently', async () => {
    const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);

    const results = await Promise.all([verify(order.orderNumber), verify(order.orderNumber)]);
    // "status errorCode" per response, so a failure shows what each request got
    const outcomes = results.map((r) => `${r.statusCode} ${r.body?.errorCode ?? ''}`.trim()).sort();

    expect(outcomes.filter((o) => o === '200')).toHaveLength(1);
    // The loser sees either the pre-check (400) or the conditional update conflict (409)
    expect(['400 ORDER_NOT_READY_FOR_PICKUP', '409 ORDER_STATUS_CONFLICT']).toContain(
      outcomes.find((o) => o !== '200'),
    );

    const handoverLogs = await prisma.auditLog.count({
      where: { action: 'VERIFY_PICKUP_HANDOVER', details: { contains: order.orderNumber } },
    });
    expect(handoverLogs).toEqual(1);

    await prisma.auditLog.deleteMany({
      where: { action: 'VERIFY_PICKUP_HANDOVER', details: { contains: '#UB-P004-' } },
    });
  });

  describe('pickup-check: see the order and its payment before handover (changes nothing)', () => {
    it('Pay at Store: shows the cash to collect and allows handover, without changing the order', async () => {
      const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);

      const res = await check(order.orderNumber);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toMatchObject({
        orderNumber: order.orderNumber,
        customerName: 'Pickup Guard Customer',
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        orderStatus: 'READY_FOR_PICKUP',
        total: 100,
        amountToCollect: 100,
        canHandover: true,
        blockedReason: null,
      });
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.orderStatus).toEqual(OrderStatus.READY_FOR_PICKUP);
      expect(after.paymentStatus).toEqual(PaymentStatus.PENDING);
      expect(await prisma.auditLog.count({ where: { details: { contains: order.orderNumber } } })).toEqual(0);
    });

    it('paid online: nothing to collect', async () => {
      const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP, PaymentStatus.PAID, 'ONLINE');
      const res = await check(order.orderNumber);
      expect(res.body.data).toMatchObject({ paymentMethod: 'ONLINE', paymentStatus: 'PAID', amountToCollect: 0, canHandover: true });
    });

    it('online payment not done: shows why it cannot be handed over', async () => {
      const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP, PaymentStatus.PENDING, 'ONLINE');
      const res = await check(order.orderNumber);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toMatchObject({ canHandover: false, amountToCollect: 0 });
      expect(res.body.data.blockedReason).toContain('Online payment is pending');
    });

    it('not ready yet: shows the status, handover not allowed', async () => {
      const order = await createPickupOrder(OrderStatus.CONFIRMED);
      const res = await check(order.orderNumber);
      expect(res.body.data).toMatchObject({ orderStatus: 'CONFIRMED', canHandover: false });
      expect(res.body.data.blockedReason).toContain('READY_FOR_PICKUP');
    });

    it('wrong phone or another store: same errors as handover', async () => {
      const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);
      const wrong = await check(order.orderNumber, '+919000000001');
      expect(wrong.statusCode).toEqual(404);
      expect(wrong.body.errorCode).toEqual('PICKUP_ORDER_NOT_FOUND');

      const otherManager = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager2@uniquebasket.com' }, include: { managers: true } });
      const otherToken = generateAccessToken({ id: otherManager.id, role: 'STORE_MANAGER', email: otherManager.email, storeId: otherManager.managers[0]?.storeId });
      const forbidden = await check(order.orderNumber, customerPhone, otherToken);
      expect(forbidden.statusCode).toEqual(403);
      expect(forbidden.body.errorCode).toEqual('STORE_ACCESS_FORBIDDEN');
    });

    it('handover response also reports the payment method', async () => {
      const order = await createPickupOrder(OrderStatus.READY_FOR_PICKUP);
      const res = await verify(order.orderNumber);
      expect(res.body.data).toMatchObject({ paymentMethod: 'COD', paymentStatus: 'PAID', amountToCollect: 0 });
      await prisma.auditLog.deleteMany({ where: { action: 'VERIFY_PICKUP_HANDOVER', details: { contains: '#UB-P004-' } } });
    });
  });
});
