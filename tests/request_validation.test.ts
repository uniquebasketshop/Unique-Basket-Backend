import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { toNumber, v, validate } from '../src/validation/validator';
import { createOrderSchema, updateProfileSchema } from '../src/validation/schemas';

// P2-01: request validation layer.
describe('Request validation layer (P2-01)', () => {
  describe('validator core', () => {
    it('reports the first failing field in schema order with its errorCode', () => {
      const schema = {
        a: v.requiredString({ errorCode: 'A_BAD', message: 'a' }),
        b: v.number({ errorCode: 'B_BAD', message: 'b', positive: true }),
      };
      expect(validate(schema, {})).toEqual({ ok: false, issue: { errorCode: 'A_BAD', message: 'a' } });
      expect(validate(schema, { a: 'x', b: -1 })).toEqual({ ok: false, issue: { errorCode: 'B_BAD', message: 'b' } });
      expect(validate(schema, { a: '  x ', b: '2.5' })).toEqual({ ok: true, data: { a: 'x', b: 2.5 } });
      expect(validate(schema, null)).toMatchObject({ ok: false });
    });

    it('parses numbers strictly', () => {
      expect(toNumber(3)).toBe(3);
      expect(toNumber('1.25')).toBe(1.25);
      expect(toNumber('abc')).toBeNull();
      expect(toNumber('1e3')).toBeNull();
      expect(toNumber(NaN)).toBeNull();
      expect(toNumber(Infinity)).toBeNull();
      expect(toNumber(true)).toBeNull();
      expect(toNumber('')).toBeNull();
    });

    it('validates nested array items', () => {
      expect(validate(createOrderSchema, { fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: [{ quantity: 1 }] })).toMatchObject({
        ok: false,
        issue: { errorCode: 'MISSING_PARAMETERS' },
      });
      expect(validate(createOrderSchema, { fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: ['x'] })).toMatchObject({
        ok: false,
        issue: { errorCode: 'MISSING_PARAMETERS' },
      });
      expect(validate(createOrderSchema, { fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: [{ productId: 'p', quantity: '0' }] })).toMatchObject({
        ok: false,
        issue: { errorCode: 'INVALID_QUANTITY' },
      });
    });

    it('normalises profile fields', () => {
      const result = validate(updateProfileSchema, { name: ' Asha ', email: null, gender: 'female', dob: '1990-05-01' });
      expect(result).toEqual({
        ok: true,
        data: { name: 'Asha', email: null, gender: 'Female', dob: new Date(Date.UTC(1990, 4, 1)) },
      });
    });
  });

  describe('API', () => {
    const phone = '+919777700901';
    let customerToken: string;
    let customerId: string;
    let adminToken: string;
    let productId: string;
    let categoryId: string;

    beforeAll(async () => {
      const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Validation Customer' } });
      customerId = user.id;
      customerToken = generateAccessToken({ id: user.id, role: 'customer', phone });
      const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
      adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
      categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
      productId = (await prisma.product.create({ data: { name: 'P201 Validation Product', categoryId, unit: 'KG', price: 10, mrp: 12 } })).id;
    });

    afterAll(async () => {
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
      await prisma.userAddress.deleteMany({ where: { userId: customerId } });
      await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.user.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    const customer = () => ({ Authorization: `Bearer ${customerToken}` });
    const admin = () => ({ Authorization: `Bearer ${adminToken}` });

    it('clearing email with null no longer crashes the profile update', async () => {
      await prisma.user.update({ where: { id: customerId }, data: { email: 'old@example.com' } });
      const res = await request(app).put('/api/v1/customer/profile').set(customer()).send({ email: null });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.user.email).toBeNull();
    });

    it('keeps existing profile error codes', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ name: '' }, 'INVALID_NAME'],
        [{ name: 'x'.repeat(101) }, 'NAME_TOO_LONG'],
        [{ email: 'nope' }, 'INVALID_EMAIL'],
        [{ dob: '2999-01-01' }, 'FUTURE_DOB'],
        [{ dob: 'yesterday' }, 'INVALID_DOB'],
        [{ gender: 'robot' }, 'INVALID_GENDER'],
      ];
      for (const [body, errorCode] of cases) {
        const res = await request(app).put('/api/v1/customer/profile').set(customer()).send(body);
        expect(res.statusCode).toEqual(400);
        expect(res.body).toEqual({ success: false, message: expect.any(String), errorCode });
      }
    });

    it('rejects out-of-range or non-numeric address coordinates with INVALID_COORDINATES', async () => {
      const pincode = (await prisma.supportedPincode.findFirstOrThrow({ where: { isActive: true } })).pincode;
      for (const coords of [{ latitude: 'abc' }, { latitude: 95 }, { longitude: -200 }]) {
        const res = await request(app)
          .post('/api/v1/customer/addresses')
          .set(customer())
          .send({ addressLine: '1 Test Street', pincode, ...coords });
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toBe('INVALID_COORDINATES');
      }
      const ok = await request(app)
        .post('/api/v1/customer/addresses')
        .set(customer())
        .send({ addressLine: '1 Test Street', pincode, latitude: '22.30', longitude: 70.8 });
      expect(ok.statusCode).toEqual(201);
      expect(Number(ok.body.data.address.latitude)).toBeCloseTo(22.3);
    });

    it('a non-numeric cart update quantity is rejected instead of deleting the line', async () => {
      const add = await request(app).post('/api/v1/cart/items').set(customer()).send({ productId, quantity: 2 });
      expect(add.statusCode).toEqual(201);
      const res = await request(app).put(`/api/v1/cart/items/${add.body.data.id}`).set(customer()).send({ quantity: 'lots' });
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('INVALID_QUANTITY');
      expect(await prisma.cartItem.count({ where: { id: add.body.data.id } })).toBe(1);

      // 0 still removes the line (existing contract)
      const removed = await request(app).put(`/api/v1/cart/items/${add.body.data.id}`).set(customer()).send({ quantity: 0 });
      expect(removed.statusCode).toEqual(200);
      expect(await prisma.cartItem.count({ where: { id: add.body.data.id } })).toBe(0);
    });

    it('rejects malformed order items with stable codes before touching the database', async () => {
      const place = (body: Record<string, unknown>) => request(app).post('/api/v1/orders').set(customer()).send(body);
      expect((await place({ fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: [{ quantity: 1 }] })).body.errorCode).toBe('MISSING_PARAMETERS');
      expect((await place({ fulfillmentType: 'PICKUP', paymentMethod: 'COD', items: [{ productId, quantity: 'x' }] })).body.errorCode).toBe('INVALID_QUANTITY');
      expect((await place({ fulfillmentType: 'PICKUP', paymentMethod: 'CARD', items: [{ productId, quantity: 1 }] })).body.errorCode).toBe('INVALID_PAYMENT_METHOD');
      expect((await place({ paymentMethod: 'CARD', items: [] })).body.errorCode).toBe('MISSING_PARAMETERS');
    });

    it('validates admin product fields', async () => {
      const bad = await request(app).post('/api/v1/products').set(admin()).send({ name: 'P201 Bad Price', categoryId, unit: 'KG', price: 'abc' });
      expect(bad.statusCode).toEqual(400);
      expect(bad.body.errorCode).toBe('VALIDATION_ERROR');

      const missing = await request(app).post('/api/v1/products').set(admin()).send({ name: 'P201 Missing', unit: 'KG', price: 5 });
      expect(missing.body.errorCode).toBe('MISSING_PARAMETERS');

      const clearMrp = await request(app).put(`/api/v1/products/${productId}`).set(admin()).send({ mrp: null });
      expect(clearMrp.statusCode).toEqual(200);
      expect(clearMrp.body.data.mrp).toBeNull();

      const badActive = await request(app).put(`/api/v1/products/${productId}`).set(admin()).send({ isActive: 'yes' });
      expect(badActive.body.errorCode).toBe('VALIDATION_ERROR');
    });
  });
});
