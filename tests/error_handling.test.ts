import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P1-12: client errors return 4xx with stable error codes instead of 500.
describe('API error mapping (P1-12)', () => {
  const customerPhone = '+919888800012';
  const missingUuid = '00000000-0000-4000-8000-000000000000';
  let adminToken: string;
  let customerToken: string;
  let customerId: string;
  let storeId: string;
  let productId: string;

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUnique({ where: { email: 'superadmin@uniquebasket.com' } });
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const product = await prisma.product.findFirst({ where: { isActive: true, category: { isActive: true } } });
    if (!admin || !store || !product) throw new Error('Seed data not found.');
    storeId = store.id;
    productId = product.id;

    const user = await prisma.user.upsert({
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Error Mapping Customer' },
    });
    customerId = user.id;

    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  const expectError = (res: request.Response, status: number, errorCode: string) => {
    expect(res.statusCode).toEqual(status);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('errorCode', errorCode);
  };

  describe('invalid identifiers', () => {
    it('returns 400 INVALID_ID for a malformed order id (customer)', async () => {
      const res = await request(app).get('/api/v1/orders/not-a-uuid').set('Authorization', `Bearer ${customerToken}`);
      expectError(res, 400, 'INVALID_ID');
    });

    it('returns 400 INVALID_ID for a malformed order id (admin)', async () => {
      const res = await request(app).get('/api/v1/admin/orders/not-a-uuid').set('Authorization', `Bearer ${adminToken}`);
      expectError(res, 400, 'INVALID_ID');
    });

    it('returns 400 INVALID_ID for a malformed product id', async () => {
      const res = await request(app).get('/api/v1/products/not-a-uuid').set('Authorization', `Bearer ${customerToken}`);
      expectError(res, 400, 'INVALID_ID');
    });

    it('returns 400 INVALID_ID for a malformed store id in an inventory adjustment (raw SQL lock)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/not-a-uuid/inventory/${productId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adjustmentType: 'ADD', quantity: 1 });
      expectError(res, 400, 'INVALID_ID');
    });

    it('still returns 404 for a well-formed but unknown order id', async () => {
      const res = await request(app).get(`/api/v1/orders/${missingUuid}`).set('Authorization', `Bearer ${customerToken}`);
      expectError(res, 404, 'ORDER_NOT_FOUND');
    });
  });

  describe('malformed requests', () => {
    it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .set('Content-Type', 'application/json')
        .send('{"phone": ');
      expectError(res, 400, 'INVALID_JSON');
    });

    it('returns 400 VALIDATION_ERROR for an invalid enum value', async () => {
      const category = await prisma.category.findFirstOrThrow();
      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'P1-12 Invalid Unit', categoryId: category.id, unit: 'BUCKET', price: 10 });
      expectError(res, 400, 'VALIDATION_ERROR');
    });
  });

  describe('checkout validation', () => {
    const placeOrder = (body: Record<string, unknown>) =>
      request(app).post('/api/v1/orders').set('Authorization', `Bearer ${customerToken}`).send(body);

    it('returns 400 MISSING_ADDRESS_ID for a delivery order without address', async () => {
      const res = await placeOrder({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'COD',
        items: [{ productId, quantity: 1 }],
      });
      expectError(res, 400, 'MISSING_ADDRESS_ID');
    });

    it('returns 404 ADDRESS_NOT_FOUND for an unknown address', async () => {
      const res = await placeOrder({
        fulfillmentType: 'DELIVERY',
        addressId: missingUuid,
        paymentMethod: 'COD',
        items: [{ productId, quantity: 1 }],
      });
      expectError(res, 404, 'ADDRESS_NOT_FOUND');
    });

    it('returns 400 MISSING_STORE_ID for a pickup order without store', async () => {
      const res = await placeOrder({ fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
      expectError(res, 400, 'MISSING_STORE_ID');
    });

    it('returns 400 INVALID_FULFILLMENT_TYPE', async () => {
      const res = await placeOrder({ fulfillmentType: 'DRONE', paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
      expectError(res, 400, 'INVALID_FULFILLMENT_TYPE');
    });

    it('returns 400 INVALID_PAYMENT_METHOD', async () => {
      const res = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'CARD', items: [{ productId, quantity: 1 }] });
      expectError(res, 400, 'INVALID_PAYMENT_METHOD');
    });

    it('returns 400 INVALID_QUANTITY', async () => {
      const res = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId, quantity: -1 }] });
      expectError(res, 400, 'INVALID_QUANTITY');
    });

    it('returns 400 PRODUCT_UNAVAILABLE for an unknown product', async () => {
      const res = await placeOrder({
        fulfillmentType: 'PICKUP',
        storeId,
        paymentMethod: 'COD',
        items: [{ productId: missingUuid, quantity: 1 }],
      });
      expectError(res, 400, 'PRODUCT_UNAVAILABLE');
    });
  });

  describe('inventory adjustment validation', () => {
    const adjust = (body: Record<string, unknown>) =>
      request(app)
        .put(`/api/v1/products/store/${storeId}/inventory/${productId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);

    it('returns 400 INVALID_ADJUSTMENT_TYPE', async () => {
      expectError(await adjust({ adjustmentType: 'MULTIPLY', quantity: 2 }), 400, 'INVALID_ADJUSTMENT_TYPE');
    });

    it('returns 400 INVALID_QUANTITY for a negative adjustment', async () => {
      expectError(await adjust({ adjustmentType: 'ADD', quantity: -5 }), 400, 'INVALID_QUANTITY');
    });

    it('returns 400 INVALID_QUANTITY for a non-numeric stock override', async () => {
      expectError(await adjust({ stockQuantity: 'lots' }), 400, 'INVALID_QUANTITY');
    });
  });
});
