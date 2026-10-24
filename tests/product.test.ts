import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Products, Categories & Store Isolation Integration Tests', () => {
  let superAdminToken: string;
  let manager1Token: string;
  let manager2Token: string;
  let customerToken: string;

  let centralStoreId: string;
  let eastStoreId: string;
  let appleProductId: string;

  beforeAll(async () => {
    // 1. Fetch real seeded admin users from database
    const superAdminUser = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });

    const manager1User = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });

    const manager2User = await prisma.adminUser.findUnique({
      where: { email: 'manager2@uniquebasket.com' },
      include: { managers: true },
    });

    if (!superAdminUser || !manager1User || !manager2User) {
      throw new Error('Admin seed users not found in database. Run db:seed before running tests.');
    }

    // 2. Fetch stores & products
    const centralStore = await prisma.store.findUnique({
      where: { storeId: 'STORE-001' },
    });
    const eastStore = await prisma.store.findUnique({
      where: { storeId: 'STORE-002' },
    });

    if (!centralStore || !eastStore) {
      throw new Error('Seeded stores (STORE-001, STORE-002) not found in database.');
    }

    centralStoreId = centralStore.id;
    eastStoreId = eastStore.id;

    const apple = await prisma.product.findFirst({
      where: { name: { startsWith: 'Apple' } },
    });

    if (!apple) {
      throw new Error('Seeded product "Apple" not found in database.');
    }
    appleProductId = apple.id;

    // 3. Generate tokens
    superAdminToken = generateAccessToken({
      id: superAdminUser.id,
      role: 'SUPER_ADMIN',
      email: superAdminUser.email,
    });

    manager1Token = generateAccessToken({
      id: manager1User.id,
      role: 'STORE_MANAGER',
      email: manager1User.email,
      storeId: manager1User.managers[0]?.storeId,
    });

    manager2Token = generateAccessToken({
      id: manager2User.id,
      role: 'STORE_MANAGER',
      email: manager2User.email,
      storeId: manager2User.managers[0]?.storeId,
    });

    const customer = await prisma.user.upsert({
      where: { phone: '+919999999999' },
      update: { isActive: true },
      create: { phone: '+919999999999', name: 'Product Test Customer', isActive: true },
    });

    customerToken = generateAccessToken({
      id: customer.id,
      role: 'customer',
      phone: customer.phone,
    });
  });

  afterAll(async () => {
    // Restore inventory quantities for central & east stores to avoid side effects
    await prisma.storeInventory.updateMany({
      where: {
        productId: appleProductId,
        storeId: { in: [centralStoreId, eastStoreId] },
      },
      data: { stockQuantity: 50.00 },
    });

    await prisma.auditLog.deleteMany({
      where: { action: 'UPDATE_INVENTORY' },
    });

    await prisma.$disconnect();
  });

  describe('Global Categories & Products List', () => {
    it('should allow customer to get active categories list', async () => {
      const res = await request(app)
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2); // Fruits, Vegetables
    });

    it('should allow customer to list global products', async () => {
      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('should list products with store specific inventory details', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${centralStoreId}`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      
      const appleItem = res.body.data.find((p: any) => p.id === appleProductId);
      expect(appleItem).toBeDefined();
      expect(appleItem).toHaveProperty('stockQuantity');
    });
  });

  describe('CRITICAL MULTI-STORE SECURITY TEST', () => {
    it('should allow Store Manager 1 to update inventory in their assigned Store (STORE-001)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${centralStoreId}/inventory/${appleProductId}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          stockQuantity: 45.5,
          isAvailable: true,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(Number(res.body.data.stockQuantity)).toEqual(45.5);
    });

    it('should reject Store Manager 1 trying to update inventory in Store 2 (STORE-002)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${eastStoreId}/inventory/${appleProductId}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          stockQuantity: 99.0,
        });

      // Assert backend security isolates store manager 1 from store 2
      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');
    });

    it('should reject Store Manager 2 trying to update inventory in Store 1 (STORE-001)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${centralStoreId}/inventory/${appleProductId}`)
        .set('Authorization', `Bearer ${manager2Token}`)
        .send({
          stockQuantity: 88.0,
        });

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');
    });

    it('should allow Super Admin to update inventory at any Store (STORE-002)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${eastStoreId}/inventory/${appleProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          stockQuantity: 28.5,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(Number(res.body.data.stockQuantity)).toEqual(28.5);
    });
  });
});
