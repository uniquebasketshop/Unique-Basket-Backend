import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { resetRateLimits } from '../src/middlewares/rateLimit';

/**
 * Security review, FEATURES sections B (profile) and C (addresses, public serviceability):
 * server-side validation, ownership by ID, and length limits that match the database columns.
 */
describe('Profile and address security (B, C)', () => {
  const phoneA = '+919888800501';
  const phoneB = '+919888800502';
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  let addressB: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const validAddress = { title: 'Home', addressLine: '12 Kalawad Road', city: 'Rajkot', state: 'Gujarat', pincode: '360005' };

  beforeAll(async () => {
    const a = await prisma.user.upsert({ where: { phone: phoneA }, update: {}, create: { phone: phoneA, name: 'Customer A' } });
    const b = await prisma.user.upsert({ where: { phone: phoneB }, update: {}, create: { phone: phoneB, name: 'Customer B' } });
    userA = a.id;
    userB = b.id;
    tokenA = generateAccessToken({ id: a.id, role: 'customer', phone: phoneA });
    tokenB = generateAccessToken({ id: b.id, role: 'customer', phone: phoneB });

    const res = await request(app).post('/api/v1/customer/addresses').set(as(tokenB)).send(validAddress);
    expect(res.statusCode).toEqual(201);
    addressB = res.body.data.address.id;
  });

  afterAll(async () => {
    await prisma.userAddress.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.$disconnect();
  });

  describe('profile (B-03, B-04)', () => {
    it('ignores fields a customer must not set (phone, active flag, id)', async () => {
      const res = await request(app)
        .put('/api/v1/customer/profile')
        .set(as(tokenA))
        .send({ name: 'Customer A2', phone: '+919999999999', isActive: false, id: userB });

      expect(res.statusCode).toEqual(200);
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: userA } });
      expect(stored.name).toEqual('Customer A2');
      expect(stored.phone).toEqual(phoneA);
      expect(stored.isActive).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userB } })).name).toEqual('Customer B');
    });

    it.each([
      [{ email: `${'a'.repeat(95)}@x.com` }, 'EMAIL_TOO_LONG'],
      [{ email: 'not-an-email' }, 'INVALID_EMAIL'],
      [{ name: '   ' }, 'INVALID_NAME'],
      [{ name: 'n'.repeat(101) }, 'NAME_TOO_LONG'],
      [{ dob: '2999-01-01' }, 'FUTURE_DOB'],
      [{ gender: 'robot' }, 'INVALID_GENDER'],
    ])('rejects %p with %s (400, not a server error)', async (body, errorCode) => {
      const res = await request(app).put('/api/v1/customer/profile').set(as(tokenA)).send(body);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual(errorCode);
    });
  });

  describe("another customer's address (C-02)", () => {
    it('is not listed', async () => {
      const res = await request(app).get('/api/v1/customer/addresses').set(as(tokenA));
      expect(res.statusCode).toEqual(200);
      const ids = (res.body.data.addresses as Array<{ id: string }>).map((a) => a.id);
      expect(ids).not.toContain(addressB);
    });

    it("can't be edited, made default or deleted by ID", async () => {
      const edit = await request(app).put(`/api/v1/customer/addresses/${addressB}`).set(as(tokenA)).send({ addressLine: 'Hacked' });
      const makeDefault = await request(app).patch(`/api/v1/customer/addresses/${addressB}/default`).set(as(tokenA));
      const remove = await request(app).delete(`/api/v1/customer/addresses/${addressB}`).set(as(tokenA));

      for (const res of [edit, makeDefault, remove]) {
        expect(res.statusCode).toEqual(404);
        expect(res.body.errorCode).toEqual('ADDRESS_NOT_FOUND');
      }
      const stored = await prisma.userAddress.findUniqueOrThrow({ where: { id: addressB } });
      expect(stored.addressLine).toEqual(validAddress.addressLine);
      expect(stored.userId).toEqual(userB);
    });

    it("can't be created for someone else by sending their userId", async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set(as(tokenA))
        .send({ ...validAddress, userId: userB });
      expect(res.statusCode).toEqual(201);
      expect((await prisma.userAddress.findUniqueOrThrow({ where: { id: res.body.data.address.id } })).userId).toEqual(userA);
    });
  });

  describe('address field lengths match the database (400, not a server error)', () => {
    it.each([
      [{ title: 't'.repeat(51) }, 'VALIDATION_ERROR'],
      [{ city: 'c'.repeat(101) }, 'VALIDATION_ERROR'],
      [{ state: 's'.repeat(101) }, 'VALIDATION_ERROR'],
      [{ addressLine: 'a'.repeat(501) }, 'ADDRESS_LINE_TOO_LONG'],
    ])('rejects %p on create and update', async (override, errorCode) => {
      const created = await request(app).post('/api/v1/customer/addresses').set(as(tokenB)).send({ ...validAddress, ...override });
      expect(created.statusCode).toEqual(400);
      expect(created.body.errorCode).toEqual(errorCode);

      const updated = await request(app).put(`/api/v1/customer/addresses/${addressB}`).set(as(tokenB)).send(override);
      expect(updated.statusCode).toEqual(400);
      expect(updated.body.errorCode).toEqual(errorCode);
    });

    it('accepts values at the limits', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set(as(tokenB))
        .send({ ...validAddress, title: 't'.repeat(50), city: 'c'.repeat(100), state: 's'.repeat(100), addressLine: 'a'.repeat(500) });
      expect(res.statusCode).toEqual(201);
    });
  });

  describe('any value longer than its column', () => {
    it('is answered with 400 VALUE_TOO_LONG instead of a server error', async () => {
      const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
      const adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
      // Store phone passes its format check but is longer than stores.phone (VARCHAR(15))
      const res = await request(app)
        .post('/api/v1/admin/stores')
        .set(as(adminToken))
        .send({
          storeId: `LEN-TEST-${Date.now()}`,
          name: 'Length Test Store',
          address: '1 Test Road',
          city: 'Rajkot',
          state: 'Gujarat',
          pincode: '360005',
          latitude: 22.3,
          longitude: 70.8,
          deliveryRadiusKm: 10,
          phone: '+9198765432101234567',
          openingTime: '09:00',
          closingTime: '21:00',
        });
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('VALUE_TOO_LONG');
    });
  });

  describe('public serviceability endpoints (C-05)', () => {
    beforeAll(() => {
      process.env.RATE_LIMIT_IN_TESTS = 'true';
      resetRateLimits();
    });
    afterAll(() => {
      delete process.env.RATE_LIMIT_IN_TESTS;
      resetRateLimits();
    });

    it('work without login', async () => {
      expect((await request(app).get('/api/v1/customer/pincodes')).statusCode).toEqual(200);
      expect((await request(app).get('/api/v1/customer/delivery-settings')).statusCode).toEqual(200);
    });

    it('are rate limited per IP', async () => {
      resetRateLimits();
      let last = 0;
      for (let i = 0; i < 301; i++) {
        last = (await request(app).get('/api/v1/customer/serviceability/check?pincode=360005')).statusCode;
      }
      expect(last).toEqual(429);
    });
  });
});
