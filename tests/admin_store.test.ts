import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Admin Store Management', () => {
  let superAdminToken: string;
  let managerToken: string;
  let superAdminId: string;
  let managerStoreId: string;

  const testStoreData = {
    storeId: 'TEST-STORE-001',
    name: 'Test Store',
    address: '123 Test St',
    city: 'Test City',
    state: 'TS',
    pincode: '123456',
    latitude: 12.34,
    longitude: 56.78,
    deliveryRadiusKm: 15,
    phone: '+911234567890',
    email: 'teststore@example.com',
    openingTime: '09:00',
    closingTime: '21:00',
  };

  beforeAll(async () => {
    const superAdminUser = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });
    if (!superAdminUser) throw new Error('Super admin not found');
    superAdminId = superAdminUser.id;
    superAdminToken = generateAccessToken({
      id: superAdminUser.id,
      role: 'SUPER_ADMIN',
      email: superAdminUser.email,
    });

    const managerUser = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    if (!managerUser || !managerUser.managers[0]) throw new Error('Manager not found');
    managerStoreId = managerUser.managers[0].storeId;
    managerToken = generateAccessToken({
      id: managerUser.id,
      role: 'STORE_MANAGER',
      email: managerUser.email,
      storeId: managerStoreId,
    });
  });

  afterAll(async () => {
    await prisma.store.deleteMany({ where: { storeId: testStoreData.storeId } });
    await prisma.auditLog.deleteMany({
      where: {
        adminUserId: superAdminId,
        action: { in: ['CREATE_STORE', 'UPDATE_STORE', 'DEACTIVATE_STORE'] },
      },
    });
    await prisma.$disconnect();
  });

  test('Super Admin can list all stores', async () => {
    const res = await request(app)
      .get('/api/v1/admin/stores')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  test('Store Manager list returns only their store', async () => {
    const res = await request(app)
      .get('/api/v1/admin/stores')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(managerStoreId);
  });

  test('Super Admin can get any store by id', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/stores/${managerStoreId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(managerStoreId);
  });

  test('Store Manager can get own store', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/stores/${managerStoreId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(managerStoreId);
  });

  test('Store Manager cannot get another store', async () => {
    const otherStore = await prisma.store.findFirst({ where: { id: { not: managerStoreId } } });
    if (!otherStore) return;
    const res = await request(app)
      .get(`/api/v1/admin/stores/${otherStore.id}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('STORE_ACCESS_FORBIDDEN');
  });

  test('Super Admin can create a new store', async () => {
    const res = await request(app)
      .post('/api/v1/admin/stores')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(testStoreData);
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.storeId).toBe(testStoreData.storeId);
    const audit = await prisma.auditLog.findFirst({
      where: { adminUserId: superAdminId, action: 'CREATE_STORE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeDefined();
  });

  test('Super Admin cannot create duplicate storeId', async () => {
    const res = await request(app)
      .post('/api/v1/admin/stores')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(testStoreData);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('DUPLICATE_STORE_ID');
  });

  test('Store Manager cannot create a store', async () => {
    const res = await request(app)
      .post('/api/v1/admin/stores')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ...testStoreData, storeId: 'MANAGER-ATTEMPT' });
    expect(res.statusCode).toBe(403);
  });

  test('Super Admin can update a store', async () => {
    const store = await prisma.store.findUnique({ where: { storeId: testStoreData.storeId } });
    if (!store) throw new Error('Test store not found for update');
    const res = await request(app)
      .put(`/api/v1/admin/stores/${store.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Updated Test Store' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const audit = await prisma.auditLog.findFirst({
      where: { adminUserId: superAdminId, action: 'UPDATE_STORE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeDefined();
  });

  test('Store Manager cannot update a store', async () => {
    const store = await prisma.store.findUnique({ where: { storeId: testStoreData.storeId } });
    if (!store) return;
    const res = await request(app)
      .put(`/api/v1/admin/stores/${store.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'Manager Attempt Update' });
    expect(res.statusCode).toBe(403);
  });

  test('Super Admin can soft delete (deactivate) a store', async () => {
    const store = await prisma.store.findUnique({ where: { storeId: testStoreData.storeId } });
    if (!store) throw new Error('Test store not found for delete');
    const res = await request(app)
      .delete(`/api/v1/admin/stores/${store.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const deactivated = await prisma.store.findUnique({ where: { id: store.id } });
    expect(deactivated?.isActive).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { adminUserId: superAdminId, action: 'DEACTIVATE_STORE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeDefined();
  });

  test('Unauthenticated request is rejected', async () => {
    const res = await request(app).get('/api/v1/admin/stores');
    expect(res.statusCode).toBe(401);
  });
});
