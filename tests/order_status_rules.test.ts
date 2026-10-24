import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { FulfillmentType, OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';

// P0-05: fulfillment-aware transitions, pickup completion only via verification (D-006),
// unpaid ONLINE orders can only be cancelled (D-005), auto-PAID on completion only for COD.
describe('Admin order status rules (P0-05)', () => {
  const customerPhone = '+919888800005';
  let customerId: string;
  let storeId: string;
  let adminToken: string;
  let seq = 0;

  const createOrder = async (opts: {
    fulfillmentType: FulfillmentType;
    paymentMethod: PaymentMethod;
    paymentStatus?: PaymentStatus;
    orderStatus: OrderStatus;
  }) => {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-P005-${Date.now()}-${seq}`,
        userId: customerId,
        storeId,
        fulfillmentType: opts.fulfillmentType,
        subtotal: 200,
        deliveryFee: 0,
        codCharge: 0,
        total: 200,
        paymentMethod: opts.paymentMethod,
        paymentStatus: opts.paymentStatus ?? PaymentStatus.PENDING,
        orderStatus: opts.orderStatus,
      },
    });
  };

  const setStatus = (orderId: string, status: string) =>
    request(app)
      .put(`/api/v1/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });

  const reload = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUnique({ where: { email: 'superadmin@uniquebasket.com' } });
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    if (!admin || !store) throw new Error('Seeded super admin or STORE-001 not found.');
    storeId = store.id;

    const user = await prisma.user.upsert({
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Status Rules Customer' },
    });
    customerId = user.id;

    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.auditLog.deleteMany({ where: { details: { contains: '#UB-P005-' } } });
    await prisma.$disconnect();
  });

  describe('fulfillment-aware transitions', () => {
    it.each([['OUT_FOR_DELIVERY'], ['DELIVERED']])(
      'rejects %s for a PICKUP order',
      async (target) => {
        const from = target === 'DELIVERED' ? OrderStatus.OUT_FOR_DELIVERY : OrderStatus.CONFIRMED;
        const order = await createOrder({ fulfillmentType: 'PICKUP', paymentMethod: 'COD', orderStatus: from });

        const res = await setStatus(order.id, target);

        expect(res.statusCode).toEqual(400);
        expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_FOR_FULFILLMENT');
        expect((await reload(order.id)).orderStatus).toEqual(from);
      }
    );

    it('rejects PICKED_UP for a DELIVERY order', async () => {
      const order = await createOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'COD',
        orderStatus: OrderStatus.READY_FOR_PICKUP,
      });

      const res = await setStatus(order.id, 'PICKED_UP');

      expect(res.statusCode).toEqual(400);
      expect((await reload(order.id)).orderStatus).toEqual(OrderStatus.READY_FOR_PICKUP);
    });

    it('allows the DELIVERY path CONFIRMED -> OUT_FOR_DELIVERY -> DELIVERED (D-013)', async () => {
      const order = await createOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'COD',
        orderStatus: OrderStatus.CONFIRMED,
      });

      expect((await setStatus(order.id, 'OUT_FOR_DELIVERY')).statusCode).toEqual(200);
      const res = await setStatus(order.id, 'DELIVERED');
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.paymentStatus).toEqual('PAID'); // COD cash collected on delivery
    });

    it('rejects cancelling an order that is OUT_FOR_DELIVERY (D-013)', async () => {
      const order = await createOrder({ fulfillmentType: 'DELIVERY', paymentMethod: 'COD', orderStatus: OrderStatus.OUT_FOR_DELIVERY });

      const res = await setStatus(order.id, 'CANCELLED');

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_TRANSITION');
      expect((await reload(order.id)).orderStatus).toEqual(OrderStatus.OUT_FOR_DELIVERY);
    });

    it('rejects READY_FOR_PICKUP for a DELIVERY order (D-013)', async () => {
      const order = await createOrder({ fulfillmentType: 'DELIVERY', paymentMethod: 'COD', orderStatus: OrderStatus.CONFIRMED });

      const res = await setStatus(order.id, 'READY_FOR_PICKUP');

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_FOR_FULFILLMENT');
      expect((await reload(order.id)).orderStatus).toEqual(OrderStatus.CONFIRMED);
    });

    it.each<[FulfillmentType]>([['DELIVERY'], ['PICKUP']])('rejects moving a %s order to PREPARING (D-013)', async (fulfillmentType) => {
      const order = await createOrder({ fulfillmentType, paymentMethod: 'COD', orderStatus: OrderStatus.CONFIRMED });

      const res = await setStatus(order.id, 'PREPARING');

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_TRANSITION');
    });

    it('lets legacy PREPARING orders advance to their next step (D-013)', async () => {
      const delivery = await createOrder({ fulfillmentType: 'DELIVERY', paymentMethod: 'COD', orderStatus: OrderStatus.PREPARING });
      const pickup = await createOrder({ fulfillmentType: 'PICKUP', paymentMethod: 'COD', orderStatus: OrderStatus.PREPARING });

      expect((await setStatus(delivery.id, 'OUT_FOR_DELIVERY')).statusCode).toEqual(200);
      expect((await setStatus(pickup.id, 'READY_FOR_PICKUP')).statusCode).toEqual(200);
    });
  });

  describe('pickup completion only via verification (D-006)', () => {
    it('rejects PICKED_UP on the status endpoint for a READY_FOR_PICKUP pickup order', async () => {
      const order = await createOrder({
        fulfillmentType: 'PICKUP',
        paymentMethod: 'COD',
        orderStatus: OrderStatus.READY_FOR_PICKUP,
      });

      const res = await setStatus(order.id, 'PICKED_UP');

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'PICKUP_VERIFICATION_REQUIRED');
      const after = await reload(order.id);
      expect(after.orderStatus).toEqual(OrderStatus.READY_FOR_PICKUP);
      expect(after.paymentStatus).toEqual(PaymentStatus.PENDING);
    });
  });

  describe('unpaid ONLINE orders (D-005)', () => {
    it.each([
      [PaymentStatus.PENDING, OrderStatus.PLACED, 'CONFIRMED'],
      [PaymentStatus.FAILED, OrderStatus.PLACED, 'CONFIRMED'],
      [PaymentStatus.PENDING, OrderStatus.OUT_FOR_DELIVERY, 'DELIVERED'],
      [PaymentStatus.FAILED, OrderStatus.OUT_FOR_DELIVERY, 'DELIVERED'],
    ])('rejects advancing a %s ONLINE order from %s to %s', async (paymentStatus, from, target) => {
      const order = await createOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'ONLINE',
        paymentStatus,
        orderStatus: from,
      });

      const res = await setStatus(order.id, target);

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'ONLINE_PAYMENT_PENDING');
      const after = await reload(order.id);
      expect(after.orderStatus).toEqual(from);
      expect(after.paymentStatus).toEqual(paymentStatus); // never silently becomes PAID
    });

    it('allows cancelling an unpaid ONLINE order', async () => {
      const order = await createOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'ONLINE',
        orderStatus: OrderStatus.PLACED,
      });

      const res = await setStatus(order.id, 'CANCELLED');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CANCELLED');
    });

    it('allows advancing a PAID ONLINE order and keeps payment PAID on delivery', async () => {
      const order = await createOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'ONLINE',
        paymentStatus: PaymentStatus.PAID,
        orderStatus: OrderStatus.OUT_FOR_DELIVERY,
      });

      const res = await setStatus(order.id, 'DELIVERED');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.paymentStatus).toEqual('PAID');
    });
  });
});
