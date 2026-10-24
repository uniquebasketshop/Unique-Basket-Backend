import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { OrderStatus } from '@prisma/client';

// P0-06: no lost updates on stock, no double restore on cancellation.
describe('Inventory concurrency safety (P0-06)', () => {
  const customerPhone = '+919888800006';
  let customerId: string;
  let storeId: string;
  let productId: string;
  let adminToken: string;
  let customerToken: string;
  let seq = 0;

  const stockOf = async () =>
    Number(
      (await prisma.storeInventory.findUniqueOrThrow({
        where: { storeId_productId: { storeId, productId } },
      })).stockQuantity
    );

  const setStock = (qty: number) =>
    prisma.storeInventory.upsert({
      where: { storeId_productId: { storeId, productId } },
      update: { stockQuantity: qty, isAvailable: true },
      create: { storeId, productId, stockQuantity: qty, isAvailable: true },
    });

  const createPlacedOrder = async (qty: number) => {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-P006-${Date.now()}-${seq}`,
        userId: customerId,
        storeId,
        fulfillmentType: 'PICKUP',
        subtotal: 200 * qty,
        deliveryFee: 0,
        codCharge: 0,
        total: 200 * qty,
        paymentMethod: 'COD',
        orderStatus: OrderStatus.PLACED,
        items: {
          create: [{ productId, productName: 'P006 Test Product', quantity: qty, unitPrice: 200, totalPrice: 200 * qty }],
        },
      },
    });
  };

  const cancel = (orderId: string) =>
    request(app)
      .put(`/api/v1/admin/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CANCELLED' });

  const adjust = (body: Record<string, unknown>) =>
    request(app)
      .put(`/api/v1/products/store/${storeId}/inventory/${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  const statusAuditLogs = (orderNumber: string) =>
    prisma.auditLog.count({ where: { action: 'UPDATE_ORDER_STATUS', details: { contains: orderNumber } } });

  const customerNotifications = (orderId: string) =>
    prisma.notification.count({ where: { userId: customerId, orderId } });

  const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 3000) => {
    const start = Date.now();
    while (!(await condition())) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const restoreLogs = (orderNumber: string) =>
    prisma.inventoryTransaction.count({
      where: { productId, type: 'ORDER_CANCELLATION_RESTORE', reason: { contains: orderNumber } },
    });

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUnique({ where: { email: 'superadmin@uniquebasket.com' } });
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const anyProduct = await prisma.product.findFirst({ where: { isActive: true, category: { isActive: true } } });
    if (!admin || !store || !anyProduct) throw new Error('Seed data not found.');
    storeId = store.id;

    const product = await prisma.product.create({
      data: { name: 'P006 Test Product', categoryId: anyProduct.categoryId, unit: 'KG', price: 200 },
    });
    productId = product.id;

    const user = await prisma.user.upsert({
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Inventory Concurrency Customer' },
    });
    customerId = user.id;

    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.cartItem.deleteMany({ where: { userId: customerId } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.auditLog.deleteMany({ where: { details: { contains: '#UB-P006-' } } });
    await prisma.$disconnect();
  });

  describe('order cancellation', () => {
    it('restores stock exactly once when the same order is cancelled concurrently', async () => {
      await setStock(10);
      const order = await createPlacedOrder(2);

      const results = await Promise.all([cancel(order.id), cancel(order.id), cancel(order.id)]);
      const codes = results.map((r) => r.statusCode);

      // One request cancels. Others lose the claim (409) or, if they read the order after it was
      // cancelled, are a same-status no-op (200). Either way stock comes back once.
      expect(codes).toContain(200);
      expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
      expect(await stockOf()).toEqual(12);
      expect(await restoreLogs(order.orderNumber)).toEqual(1);
      expect(await statusAuditLogs(order.orderNumber)).toEqual(1);
    });

    it('does not restore stock again when an already cancelled order is "cancelled" again', async () => {
      await setStock(10);
      const order = await createPlacedOrder(3);

      expect((await cancel(order.id)).statusCode).toEqual(200);
      expect(await stockOf()).toEqual(13);

      expect((await cancel(order.id)).statusCode).toEqual(200);
      expect(await stockOf()).toEqual(13);
      expect(await restoreLogs(order.orderNumber)).toEqual(1);
    });

    it('sends one notification and writes one audit entry when a cancel is repeated (G-03)', async () => {
      await setStock(10);
      const order = await createPlacedOrder(1);

      const first = await cancel(order.id);
      const repeat = await cancel(order.id);

      expect(first.statusCode).toEqual(200);
      expect(repeat.statusCode).toEqual(200);
      expect(repeat.body.data).toMatchObject({ id: order.id, orderStatus: 'CANCELLED' });
      expect(await statusAuditLogs(order.orderNumber)).toEqual(1);
      // The notification is sent after the response; give it a moment, then check it was sent once.
      await waitFor(async () => (await customerNotifications(order.id)) >= 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await customerNotifications(order.id)).toEqual(1);
    });

    it('recreates the inventory row instead of failing when it no longer exists', async () => {
      const order = await createPlacedOrder(1.5);
      await prisma.storeInventory.deleteMany({ where: { storeId, productId } });

      const res = await cancel(order.id);

      expect(res.statusCode).toEqual(200);
      expect(await stockOf()).toEqual(1.5);
    });

    it('logs accurate before/after values for the restore', async () => {
      await setStock(7);
      const order = await createPlacedOrder(2);

      await cancel(order.id);

      const log = await prisma.inventoryTransaction.findFirstOrThrow({
        where: { productId, type: 'ORDER_CANCELLATION_RESTORE', reason: { contains: order.orderNumber } },
      });
      expect(Number(log.previousQuantity)).toEqual(7);
      expect(Number(log.changeQuantity)).toEqual(2);
      expect(Number(log.newQuantity)).toEqual(9);
    });
  });

  describe('manual inventory adjustments', () => {
    it('applies every concurrent ADD (no lost updates) with a consistent history', async () => {
      await setStock(0);
      await prisma.inventoryTransaction.deleteMany({ where: { productId, type: 'STOCK_ADDED' } });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => adjust({ adjustmentType: 'ADD', quantity: 1, reason: 'P006 concurrent add' }))
      );

      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(await stockOf()).toEqual(10);

      const history = await prisma.inventoryTransaction.findMany({
        where: { productId, type: 'STOCK_ADDED' },
        orderBy: { newQuantity: 'asc' },
      });
      expect(history.map((h) => Number(h.newQuantity))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      history.forEach((h) => expect(Number(h.newQuantity) - Number(h.previousQuantity)).toEqual(1));
    });

    it('never lets concurrent REMOVEs drive stock negative', async () => {
      await setStock(5);

      const results = await Promise.all(
        Array.from({ length: 8 }, () => adjust({ adjustmentType: 'REMOVE', quantity: 1, reason: 'P006 concurrent remove' }))
      );
      const ok = results.filter((r) => r.statusCode === 200).length;
      const blocked = results.filter((r) => r.statusCode === 400).length;

      expect(ok).toEqual(5);
      expect(blocked).toEqual(3);
      expect(await stockOf()).toEqual(0);
    });

    it('keeps stock consistent when a checkout races a manual ADD', async () => {
      await setStock(5);
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });

      const [checkout, add] = await Promise.all([
        request(app)
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            fulfillmentType: 'PICKUP',
            storeId,
            paymentMethod: 'COD',
            items: [{ productId, quantity: 2 }],
          }),
        adjust({ adjustmentType: 'ADD', quantity: 3, reason: 'P006 race add' }),
      ]);

      expect(add.statusCode).toEqual(200);
      const orderPlaced = checkout.statusCode === 201;
      // Either the checkout succeeded (stock 5 + 3 - 2) or it was rejected; never a lost update.
      expect(await stockOf()).toEqual(orderPlaced ? 6 : 8);
    });
  });
});
