import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Store Manager Management & Isolation Integration Tests', () => {
  let superAdminToken: string;
  let manager1Token: string;
  let customerToken: string;
  
  let centralStoreId: string;
  let eastStoreId: string;
  let testManagerId: string;
  const testEmail = 'temporary.manager@uniquebasket.com';

  beforeAll(async () => {
    // 1. Load active admin tokens and store IDs
    const superAdmin = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });
    superAdminToken = generateAccessToken({
      id: superAdmin!.id,
      role: 'SUPER_ADMIN',
      email: superAdmin!.email,
    });

    const manager1 = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    manager1Token = generateAccessToken({
      id: manager1!.id,
      role: 'STORE_MANAGER',
      email: manager1!.email,
      storeId: manager1!.managers[0].storeId,
    });

    const customer = await prisma.user.upsert({
      where: { phone: '+919999999999' },
      update: {},
      create: { phone: '+919999999999', name: 'Test Customer' },
    });
    customerToken = generateAccessToken({
      id: customer.id,
      role: 'customer',
      email: customer.phone,
    });

    const centralStore = await prisma.store.findFirst({
      where: { storeId: 'STORE-001' },
    });
    centralStoreId = centralStore!.id;

    const eastStore = await prisma.store.findFirst({
      where: { storeId: 'STORE-002' },
    });
    eastStoreId = eastStore!.id;
  });

  afterAll(async () => {
    // Clean up created manager accounts
    await prisma.storeManager.deleteMany({
      where: { adminUser: { email: testEmail } },
    });
    await prisma.adminUser.deleteMany({
      where: { email: testEmail },
    });
    await prisma.$disconnect();
  });

  describe('CRUD Authorization Guards', () => {
    it('should reject list managers request if token is missing or customer', async () => {
      const res = await request(app).get('/api/v1/admin/managers');
      expect(res.statusCode).toEqual(401);

      const resCustomer = await request(app)
        .get('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(resCustomer.statusCode).toEqual(403);
    });

    it('should reject manager management if token is a Store Manager', async () => {
      const res = await request(app)
        .get('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${manager1Token}`);
      expect(res.statusCode).toEqual(403);
    });

    it('should allow Super Admin to list store managers', async () => {
      const res = await request(app)
        .get('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('Create & Validation Operations', () => {
    it('should reject manager creation with missing parameters', async () => {
      const res = await request(app)
        .post('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Rahul',
          email: testEmail,
        }); // Missing password & storeId

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'MISSING_PARAMETERS');
    });

    it('should reject manager creation with invalid email format', async () => {
      const res = await request(app)
        .post('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Rahul',
          email: 'invalid-email-format',
          password: 'securePassword123',
          storeId: centralStoreId,
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_EMAIL');
    });

    it('should successfully create a store manager assigned to STORE-001', async () => {
      const res = await request(app)
        .post('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Temp Manager',
          email: testEmail,
          password: 'securePassword123',
          storeId: centralStoreId,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('storeId', centralStoreId);
      expect(res.body.data).toHaveProperty('storeIdString', 'STORE-001');

      testManagerId = res.body.data.id;
    });

    it('should reject duplicate email registration', async () => {
      const res = await request(app)
        .post('/api/v1/admin/managers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Duplicate Manager',
          email: testEmail, // duplicate
          password: 'anotherPassword123',
          storeId: eastStoreId,
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'DUPLICATE_EMAIL');
    });
  });

  describe('Update & Re-assignment Operations', () => {
    it('should allow Super Admin to change store assignment to STORE-002', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/managers/${testManagerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          storeId: eastStoreId,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('storeId', eastStoreId);
      expect(res.body.data).toHaveProperty('storeIdString', 'STORE-002');
    });

    it('should fetch manager details with updated store assignment', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/managers/${testManagerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('storeId', eastStoreId);
      expect(res.body.data).toHaveProperty('storeIdString', 'STORE-002');
    });
  });

  describe('Deactivation Controls & Immediate Session Block', () => {
    let activeToken: string;

    beforeAll(() => {
      // Generate a mock JWT token representing the test manager
      activeToken = generateAccessToken({
        id: testManagerId,
        role: 'STORE_MANAGER',
        email: testEmail,
        storeId: eastStoreId,
      });
    });

    it('should allow test manager token to access their assigned store inventory before deactivation', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${eastStoreId}`)
        .set('Authorization', `Bearer ${activeToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('should allow Super Admin to deactivate the store manager', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/managers/${testManagerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          isActive: false,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('isActive', false);
    });

    it('should immediately reject deactivated manager token access on restricted routes', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${eastStoreId}`)
        .set('Authorization', `Bearer ${activeToken}`);

      // Should return 401 ACCOUNT_DEACTIVATED immediately due to the middleware db validation
      expect(res.statusCode).toEqual(401);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'ACCOUNT_DEACTIVATED');
    });

    it('should reject login attempts from deactivated manager', async () => {
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: testEmail,
          password: 'securePassword123',
        });

      // Correct password for a deactivated account: told it is deactivated, no tokens issued.
      // (A wrong password gets the generic INVALID_CREDENTIALS, see auth.test.ts.)
      expect(res.statusCode).toEqual(401);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'ACCOUNT_DEACTIVATED');
      expect(res.body.data).toBeUndefined();
    });
  });
});
