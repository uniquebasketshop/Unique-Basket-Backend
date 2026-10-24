import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { issueRefreshToken } from '../src/services/sessionService';

/**
 * Security review, FEATURES sections G (notifications), I (catalogue admin),
 * J (stores, people, settings) and K (platform).
 */
describe('Notifications, admin and platform security (G, I, J, K)', () => {
  const phoneA = '+919888800701';
  const phoneB = '+919888800702';
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  let adminToken: string;
  let adminId: string;
  let managerToken: string;
  let storeId: string;
  const createdManagerEmails: string[] = [];

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const a = await prisma.user.upsert({ where: { phone: phoneA }, update: {}, create: { phone: phoneA, name: 'Notify A' } });
    const b = await prisma.user.upsert({ where: { phone: phoneB }, update: {}, create: { phone: phoneB, name: 'Notify B' } });
    userA = a.id;
    userB = b.id;
    tokenA = generateAccessToken({ id: a.id, role: 'customer', phone: phoneA });
    tokenB = generateAccessToken({ id: b.id, role: 'customer', phone: phoneB });

    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    adminId = admin.id;
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    const manager = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager1@uniquebasket.com' }, include: { managers: true } });
    storeId = manager.managers[0].storeId;
    managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email, storeId });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.deviceToken.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.adminUser.deleteMany({ where: { email: { in: createdManagerEmails } } });
    await prisma.$disconnect();
  });

  describe('notifications (G)', () => {
    it("a customer sees only their own notifications and can't mark someone else's as read", async () => {
      const own = await prisma.notification.create({ data: { userId: userA, title: 'A', body: 'for A', type: 'ORDER_STATUS' } });
      const other = await prisma.notification.create({ data: { userId: userB, title: 'B', body: 'for B', type: 'ORDER_STATUS' } });

      const list = await request(app).get('/api/v1/notifications').set(as(tokenA));
      expect(list.statusCode).toEqual(200);
      const body = JSON.stringify(list.body);
      expect(body).toContain(own.id);
      expect(body).not.toContain(other.id);

      const mark = await request(app).patch(`/api/v1/notifications/${other.id}/read`).set(as(tokenA));
      expect(mark.statusCode).toEqual(403);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: other.id } })).isRead).toBe(false);

      await request(app).patch('/api/v1/notifications/read-all').set(as(tokenA));
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: other.id } })).isRead).toBe(false);
    });

    it.each([
      [{ token: 'x'.repeat(4097), platform: 'ANDROID' }],
      [{ token: 'device-token-1', platform: 'SYMBIAN' }],
      [{ platform: 'IOS' }],
      [{ token: '   ', platform: 'IOS' }],
    ])('rejects an invalid device token registration %#', async (payload) => {
      const res = await request(app).post('/api/v1/notifications/tokens').set(as(tokenA)).send(payload);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('MISSING_PARAMETERS');
    });

    it('registers a valid device token for the caller', async () => {
      const res = await request(app).post('/api/v1/notifications/tokens').set(as(tokenA)).send({ token: `tok-${Date.now()}`, platform: 'ANDROID' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.userId).toEqual(userA);
    });
  });

  describe('catalogue admin (I): only the super admin can change products, categories, banners', () => {
    it.each([
      ['put', '/api/v1/products/00000000-0000-4000-8000-000000000001'],
      ['delete', '/api/v1/products/00000000-0000-4000-8000-000000000001'],
      ['put', '/api/v1/categories/00000000-0000-4000-8000-000000000001'],
      ['delete', '/api/v1/categories/00000000-0000-4000-8000-000000000001'],
      ['post', '/api/v1/admin/banners'],
      ['delete', '/api/v1/admin/banners/00000000-0000-4000-8000-000000000001'],
    ] as const)('store managers and customers are refused %s %s', async (method, path) => {
      for (const token of [managerToken, tokenA]) {
        const res = await request(app)[method](path).set(as(token)).send({ name: 'x' });
        expect(res.statusCode).toEqual(403);
      }
    });
  });

  describe('store managers (J-03)', () => {
    const newManager = (password: string) => ({
      name: 'Password Test',
      email: `pw-${Date.now()}-${Math.round(Math.random() * 1e6)}@uniquebasket.com`,
      password,
      storeId,
    });

    it.each(['short1', 'onlyletters', '12345678', 'a1'.repeat(37)])('refuses the weak password %p', async (password) => {
      const res = await request(app).post('/api/v1/admin/managers').set(as(adminToken)).send(newManager(password));
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('WEAK_PASSWORD');
    });

    it('accepts a strong password, and refuses a weak one on update', async () => {
      const body = newManager('Strong#2026');
      createdManagerEmails.push(body.email);
      const created = await request(app).post('/api/v1/admin/managers').set(as(adminToken)).send(body);
      expect(created.statusCode).toEqual(201);
      const id = created.body.data.id;

      const weak = await request(app).put(`/api/v1/admin/managers/${id}`).set(as(adminToken)).send({ password: 'weak' });
      expect(weak.statusCode).toEqual(400);
      expect(weak.body.errorCode).toEqual('WEAK_PASSWORD');
    });

    it("a store manager can't manage managers, and the managers API can't touch a super admin", async () => {
      expect((await request(app).get('/api/v1/admin/managers').set(as(managerToken))).statusCode).toEqual(403);
      expect((await request(app).put(`/api/v1/admin/managers/${adminId}`).set(as(managerToken)).send({ name: 'x' })).statusCode).toEqual(403);

      const res = await request(app).put(`/api/v1/admin/managers/${adminId}`).set(as(adminToken)).send({ isActive: false });
      expect(res.statusCode).toEqual(404);
      expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } })).isActive).toBe(true);
    });
  });

  describe('blocking a customer (J-04)', () => {
    it('stops their access token and refresh token at once', async () => {
      const refreshToken = await issueRefreshToken({ id: userB, role: 'customer' });
      expect((await request(app).get('/api/v1/customer/profile').set(as(tokenB))).statusCode).toEqual(200);

      const block = await request(app).put(`/api/v1/admin/customers/${userB}/status`).set(as(adminToken)).send({ isActive: false });
      expect(block.statusCode).toEqual(200);

      const profile = await request(app).get('/api/v1/customer/profile').set(as(tokenB));
      expect(profile.statusCode).toEqual(401);
      expect(profile.body.errorCode).toEqual('ACCOUNT_DEACTIVATED');
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).statusCode).toEqual(401);

      await prisma.user.update({ where: { id: userB }, data: { isActive: true } });
    });
  });

  describe('audit log (J-07)', () => {
    it('records successful staff sign-ins', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'ADMIN_LOGIN', adminUserId: adminId } });
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({ email: 'superadmin@uniquebasket.com', password: 'SuperSecretPassword123' });
      expect(res.statusCode).toEqual(200);
      expect(await prisma.auditLog.count({ where: { action: 'ADMIN_LOGIN', adminUserId: adminId } })).toEqual(before + 1);
    });
  });

  describe('errors (K-04)', () => {
    const savedEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = savedEnv;
    });

    it('a server error in production returns a generic message, no internals or stack', async () => {
      process.env.NODE_ENV = 'production';
      jest.spyOn(prisma.category, 'findMany').mockRejectedValue(new Error('connection string postgres://secret@db/internal'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).get('/api/v1/categories').set(as(tokenA));

      expect(res.statusCode).toEqual(500);
      expect(res.body).toEqual({ success: false, message: 'Internal server error occurred.', errorCode: 'INTERNAL_SERVER_ERROR' });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|stack|postgres/);
      errorLog.mockRestore();
    });
  });
});
