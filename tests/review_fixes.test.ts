import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { OtpService } from '../src/services/otpService';
import { createManager, updateManager } from '../src/services/managerService';

// Fixes from the branch review (2026-10-10).
describe('Branch review fixes', () => {
  const phone = '+919888800020';
  const pincode = '360920';
  let token: string;
  let userId: string;
  let adminToken: string;
  let storeOne: { id: string; latitude: unknown; longitude: unknown; pincode: string };
  let productId: string;

  const customer = (method: 'get' | 'post' | 'put', url: string) =>
    request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
  const addressOf = (res: request.Response) => res.body.data.address ?? res.body.data;

  beforeAll(async () => {
    storeOne = await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } });
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    await prisma.supportedPincode.upsert({ where: { pincode }, update: { isActive: true }, create: { pincode } });
    const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
    productId = (await prisma.product.create({ data: { name: 'Review Mango', categoryId: category.id, unit: 'KG', price: 100 } })).id;
    await prisma.storeInventory.create({ data: { storeId: storeOne.id, productId, stockQuantity: 100 } });
    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Review Customer' } });
    userId = user.id;
    token = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.cartItem.deleteMany({ where: { userId } });
    await prisma.userAddress.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.supportedPincode.deleteMany({ where: { pincode } });
    const m = await prisma.adminUser.findUnique({ where: { email: 'review.manager@uniquebasket.com' } });
    if (m) {
      await prisma.refreshToken.deleteMany({ where: { adminUserId: m.id } });
      await prisma.storeManager.deleteMany({ where: { adminUserId: m.id } });
      await prisma.adminUser.delete({ where: { id: m.id } });
    }
    await prisma.auditLog.deleteMany({ where: { details: { contains: 'Review Manager' } } });
    await prisma.$disconnect();
  });

  it('rejects a delivery order when the address pincode was deactivated after saving (D-017)', async () => {
    const saved = addressOf(await customer('post', '/customer/addresses').send({ addressLine: '1 Review Road', pincode }));
    await prisma.supportedPincode.update({ where: { pincode }, data: { isActive: false } });

    const order = await customer('post', '/orders').send({
      fulfillmentType: 'DELIVERY', addressId: saved.id, paymentMethod: 'COD', items: [{ productId, quantity: 3 }],
    });
    expect(order.statusCode).toBe(400);
    expect(order.body.errorCode).toBe('PINCODE_NOT_SERVICEABLE');
    await prisma.supportedPincode.update({ where: { pincode }, data: { isActive: true } });
  });

  it('drops the GPS point when an address moves without a new location, keeps it otherwise', async () => {
    const gps = addressOf(await customer('post', '/customer/addresses').send({
      addressLine: '2 GPS Road', pincode: storeOne.pincode, latitude: Number(storeOne.latitude) + 0.001, longitude: Number(storeOne.longitude),
    }));
    expect(gps.locationConfirmed).toBe(true);

    const sameLine = addressOf(await customer('put', `/customer/addresses/${gps.id}`).send({ addressLine: '2 GPS Road', title: 'Work' }));
    expect(sameLine.locationConfirmed).toBe(true);

    const moved = addressOf(await customer('put', `/customer/addresses/${gps.id}`).send({ addressLine: '9 Other Street', pincode }));
    expect(moved.locationConfirmed).toBe(false);
  });

  it('never leaves the customer without a default address', async () => {
    const list = await customer('get', '/customer/addresses');
    const all = list.body.data.addresses ?? list.body.data;
    const current = all.find((a: { isDefault: boolean }) => a.isDefault);
    await customer('put', `/customer/addresses/${current.id}`).send({ isDefault: false });
    const after = await prisma.userAddress.findMany({ where: { userId, isDefault: true } });
    expect(after).toHaveLength(1);
  });

  it('shows the COD charge in the cart summary', async () => {
    await prisma.cartItem.create({ data: { userId, productId, quantity: 2 } });
    const cart = await customer('get', '/cart');
    const settings = await prisma.deliverySettings.findFirst();
    expect(cart.body.data.codCharge).toBe(settings?.codEnabled === false ? 0 : Number(settings?.codCharge ?? 20));
    await prisma.cartItem.deleteMany({ where: { userId } });
  });

  it('revokes a manager\'s sessions when the password is changed', async () => {
    const actorId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } })).id;
    const created = await createManager(actorId, {
      name: 'Review Manager', email: 'review.manager@uniquebasket.com', password: 'Before#123', storeId: storeOne.id,
    });
    const login = await request(app).post('/api/v1/admin/login').send({ email: 'review.manager@uniquebasket.com', password: 'Before#123' });
    const refreshToken = login.body.data.refreshToken;
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).statusCode).toBe(200);

    await updateManager(actorId, created.id, { password: 'After#456' });
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).statusCode).toBe(401);
  });

  it('validates and caps admin order paging instead of failing', async () => {
    for (const q of ['page=0', 'page=-1', 'page=abc', 'limit=100000']) {
      const res = await request(app).get(`/api/v1/admin/orders?${q}`).set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.pagination.page).toBeGreaterThanOrEqual(1);
      expect(res.body.data.pagination.limit).toBeLessThanOrEqual(100);
    }
  });

  it('rejects store opening/closing times that are not HH:MM', async () => {
    const res = await request(app)
      .put(`/api/v1/stores/${storeOne.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closingTime: '9 PM' });
    expect(res.statusCode).toBe(400);
    expect(res.body.errorCode).toBe('INVALID_TIME_FORMAT');
  });

  it('keeps the per-phone OTP request limit after wrong attempts are used up (D-004 brute force)', async () => {
    const target = '+919888800021';
    let blocked = false;
    for (let round = 0; round < 6 && !blocked; round++) {
      const sent = await OtpService.sendOtp(target);
      if (!sent.success) { blocked = true; break; }
      for (let i = 0; i < 3; i++) await OtpService.verifyOtp(target, '0000');
    }
    // 5 requests per hour, then blocked — exhausting attempts no longer resets the count.
    expect(blocked).toBe(true);
    const verify = await OtpService.verifyOtp(target, '1234');
    expect(verify.success).toBe(false);
  });
});
