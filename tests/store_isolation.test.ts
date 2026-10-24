import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

/**
 * A-08 store isolation: a store manager of store A tries every staff route against store B.
 * Also checks that customers can't use staff routes and staff can't use customer-only routes.
 */
describe('Store isolation for store managers (A-08)', () => {
  const phone = '+919888800408';
  let storeA: string;
  let storeB: string;
  let productId: string;
  let customerId: string;
  let adminToken: string;
  let managerToken: string;
  let customerToken: string;
  let orderA: { id: string; orderNumber: string };
  let orderB: { id: string; orderNumber: string };
  let seq = 0;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  const createOrder = (storeId: string, orderStatus: 'PLACED' | 'READY_FOR_PICKUP' = 'PLACED') => {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-A008-${Date.now()}-${seq}`,
        userId: customerId,
        storeId,
        fulfillmentType: 'PICKUP',
        subtotal: 100,
        deliveryFee: 0,
        total: 100,
        paymentMethod: 'COD',
        orderStatus,
      },
    });
  };

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    const manager = await prisma.adminUser.findUniqueOrThrow({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    storeA = manager.managers[0].storeId;
    storeB = (await prisma.store.findFirstOrThrow({ where: { id: { not: storeA } } })).id;
    productId = (await prisma.product.findFirstOrThrow()).id;

    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Isolation Customer' } });
    customerId = user.id;

    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email, storeId: storeA });
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone });

    orderA = await createOrder(storeA);
    orderB = await createOrder(storeB, 'READY_FOR_PICKUP');
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.cartItem.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  describe('orders', () => {
    it('lists only own-store orders, even when another storeId is asked for', async () => {
      const res = await request(app).get(`/api/v1/admin/orders?storeId=${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      const ids = (res.body.data as Array<{ id: string; storeId: string }>).map((o) => o.id);
      expect(ids).toContain(orderA.id);
      expect(ids).not.toContain(orderB.id);
      expect((res.body.data as Array<{ storeId: string }>).every((o) => o.storeId === storeA)).toBe(true);
    });

    it("can't open another store's order", async () => {
      const res = await request(app).get(`/api/v1/admin/orders/${orderB.id}`).set(as(managerToken));
      expect(res.statusCode).toEqual(403);
      expect(res.body.errorCode).toEqual('STORE_ACCESS_FORBIDDEN');
    });

    it("can't change another store's order status", async () => {
      const res = await request(app)
        .put(`/api/v1/admin/orders/${orderB.id}/status`)
        .set(as(managerToken))
        .send({ status: 'CANCELLED' });
      expect(res.statusCode).toEqual(403);
      const unchanged = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
      expect(unchanged.orderStatus).toEqual('READY_FOR_PICKUP');
    });

    it("can't hand over another store's pickup order", async () => {
      const res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set(as(managerToken))
        .send({ orderNumber: orderB.orderNumber, phone });
      expect(res.statusCode).toEqual(403);
      const unchanged = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
      expect(unchanged.orderStatus).toEqual('READY_FOR_PICKUP');
    });
  });

  describe('payments', () => {
    it('lists only own-store payments, even when another storeId is asked for', async () => {
      const res = await request(app).get(`/api/v1/admin/payments?storeId=${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      const rows = res.body.data.payments as Array<{ id: string; store: { id: string } }>;
      expect(rows.map((o) => o.id)).not.toContain(orderB.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((o) => o.store.id === storeA)).toBe(true);
    });

    it("can't open another store's payment details", async () => {
      const res = await request(app).get(`/api/v1/admin/payments/${orderB.id}`).set(as(managerToken));
      expect(res.statusCode).toEqual(403);
    });
  });

  describe('inventory', () => {
    it("can't change another store's stock", async () => {
      const before = await prisma.storeInventory.findUnique({ where: { storeId_productId: { storeId: storeB, productId } } });
      const res = await request(app)
        .put(`/api/v1/products/store/${storeB}/inventory/${productId}`)
        .set(as(managerToken))
        .send({ adjustmentType: 'SET', quantity: 999 });
      expect(res.statusCode).toEqual(403);
      const after = await prisma.storeInventory.findUnique({ where: { storeId_productId: { storeId: storeB, productId } } });
      expect(after?.stockQuantity?.toString()).toEqual(before?.stockQuantity?.toString());
    });

    it("can't change another store's stock by also sending its own storeId in the body", async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${storeB}/inventory/${productId}`)
        .set(as(managerToken))
        .send({ adjustmentType: 'SET', quantity: 999, storeId: storeA });
      expect(res.statusCode).toEqual(403);
    });

    it("can't list another store's products with stock", async () => {
      const res = await request(app).get(`/api/v1/products/store/${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(403);
    });

    it('sees only own-store stock history, even when another storeId is asked for', async () => {
      const res = await request(app).get(`/api/v1/admin/inventory/transactions?storeId=${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      const rows = res.body.data as Array<{ storeId: string }>;
      expect(rows.every((t) => t.storeId === storeA)).toBe(true);
    });
  });

  describe('stores', () => {
    it("can't open another store in the admin API", async () => {
      const res = await request(app).get(`/api/v1/admin/stores/${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(403);
    });

    it("doesn't see another store's manager details through /stores/:id", async () => {
      const res = await request(app).get(`/api/v1/stores/${storeB}`).set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.managers).toBeUndefined();
    });

    it("sees its own store's manager details", async () => {
      const res = await request(app).get(`/api/v1/stores/${storeA}`).set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.data.managers)).toBe(true);
    });

    it('customers never see manager names or emails', async () => {
      const res = await request(app).get(`/api/v1/stores/${storeA}`).set(as(customerToken));
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.managers).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('manager1@uniquebasket.com');
    });

    it('the super admin sees manager details', async () => {
      const res = await request(app).get(`/api/v1/stores/${storeA}`).set(as(adminToken));
      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.data.managers)).toBe(true);
    });
  });

  describe('dashboard', () => {
    it("counts only own-store orders and doesn't get the all-stores count", async () => {
      const res = await request(app).get('/api/v1/admin/dashboard/summary').set(as(managerToken));
      expect(res.statusCode).toEqual(200);
      const ownStoreOrders = await prisma.order.count({ where: { storeId: storeA } });
      expect(res.body.data.totalOrders).toEqual(ownStoreOrders);
    });
  });

  describe('super-admin-only routes', () => {
    it.each([
      ['GET', '/api/v1/admin/managers'],
      ['GET', '/api/v1/admin/customers'],
      ['GET', '/api/v1/admin/audit-logs'],
      ['GET', '/api/v1/admin/settings/fare-cod'],
      ['PUT', '/api/v1/admin/settings'],
      ['GET', '/api/v1/admin/store-timings'],
      ['GET', '/api/v1/admin/banners'],
      ['GET', '/api/v1/admin/pincodes'],
      ['POST', '/api/v1/admin/stores'],
      ['POST', '/api/v1/products'],
      ['POST', '/api/v1/categories'],
    ])('a store manager is refused %s %s', async (method, path) => {
      const req = method === 'GET' ? request(app).get(path) : method === 'PUT' ? request(app).put(path) : request(app).post(path);
      const res = await req.set(as(managerToken)).send({});
      expect(res.statusCode).toEqual(403);
    });
  });

  describe('roles', () => {
    it.each([
      ['/api/v1/admin/orders'],
      ['/api/v1/admin/payments'],
      ['/api/v1/admin/dashboard/summary'],
      ['/api/v1/admin/inventory/transactions'],
      ['/api/v1/admin/stores'],
    ])('a customer is refused GET %s', async (path) => {
      const res = await request(app).get(path).set(as(customerToken));
      expect(res.statusCode).toEqual(403);
    });

    it('a customer is refused a stock change', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${storeA}/inventory/${productId}`)
        .set(as(customerToken))
        .send({ adjustmentType: 'SET', quantity: 1 });
      expect(res.statusCode).toEqual(403);
    });

    it.each([
      ['GET', '/api/v1/cart'],
      ['POST', '/api/v1/cart/items'],
      ['GET', '/api/v1/orders'],
      ['POST', '/api/v1/orders'],
    ])('staff are refused the customer-only route %s %s', async (method, path) => {
      for (const token of [managerToken, adminToken]) {
        const req = method === 'GET' ? request(app).get(path) : request(app).post(path);
        const res = await req.set(as(token)).send({});
        expect(res.statusCode).toEqual(403);
      }
    });
  });
});
