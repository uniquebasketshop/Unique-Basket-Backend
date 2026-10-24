import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Store & Location Management Integration Tests', () => {
  let superAdminToken: string;
  let managerToken: string;
  let customerToken: string;

  beforeAll(async () => {
    // Fetch actual seeded admin users from database to satisfy foreign key constraints
    const superAdminUser = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });

    const managerUser = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });

    if (!superAdminUser || !managerUser) {
      throw new Error('Seeded admin users not found in database. Run db:seed before running tests.');
    }

    superAdminToken = generateAccessToken({
      id: superAdminUser.id,
      role: 'SUPER_ADMIN',
      email: superAdminUser.email,
    });

    managerToken = generateAccessToken({
      id: managerUser.id,
      role: 'STORE_MANAGER',
      email: managerUser.email,
      storeId: managerUser.managers[0]?.storeId,
    });

    // Create or update a temporary customer in DB
    const customerUser = await prisma.user.upsert({
      where: { phone: '+919999999999' },
      update: {},
      create: { phone: '+919999999999', name: 'Test Customer' },
    });

    customerToken = generateAccessToken({
      id: customerUser.id,
      role: 'customer',
      phone: customerUser.phone,
    });
  });

  afterAll(async () => {
    // Delete any test created stores
    await prisma.store.deleteMany({
      where: { storeId: 'TEST-STORE-999' },
    });
    // Remove audit logs related to tests
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['CREATE_STORE', 'DEACTIVATE_STORE'] } },
    });
    await prisma.$disconnect();
  });

  describe('GET /api/v1/stores', () => {
    it('should list only active stores (Store One) for an authenticated customer', async () => {
      const res = await request(app)
        .get('/api/v1/stores')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      
      // Store One is active
      const storeOne = res.body.data.find((s: any) => s.storeId === 'STORE-001');
      expect(storeOne).toBeDefined();
      expect(storeOne.isActive).toBe(true);
      expect(storeOne.name).toBe('Store One');

      // Inactive stores must NOT be returned to customers
      const inactiveStores = res.body.data.filter((s: any) => !s.isActive);
      expect(inactiveStores.length).toBe(0);
    });

    it('should calculate distance and eligibility if lat/lng are provided for Store One', async () => {
      // Coordinate right at Store One (Nana Mava, Rajkot)
      // Lat: 22.308155, Lng: 70.800705
      const res = await request(app)
        .get('/api/v1/stores?lat=22.308155&lng=70.800705&fulfillment=DELIVERY')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      
      const storeOne = res.body.data.find((s: any) => s.storeId === 'STORE-001');
      expect(storeOne).toBeDefined();
      expect(storeOne.distanceKm).toBeCloseTo(0, 1);
      expect(storeOne.isEligible).toBe(true); // Distance 0 is <= 15km delivery radius
    });

    it('flags PICKUP stores within 10 km as nearby and still lists the other active stores (D-016)', async () => {
      const near = await request(app)
        .get('/api/v1/stores?lat=22.308155&lng=70.800705&fulfillment=PICKUP')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(near.statusCode).toEqual(200);
      const storeOne = near.body.data.find((s: any) => s.storeId === 'STORE-001');
      expect(storeOne.isNearby).toBe(true);
      expect(near.body.data.every((s: any) => s.isActive)).toBe(true);
      const distances = near.body.data.map((s: any) => s.distanceKm);
      expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));

      const far = await request(app)
        .get('/api/v1/stores?lat=12.9176&lng=77.6244&fulfillment=PICKUP')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(far.body.data.length).toBeGreaterThan(0);
      expect(far.body.data.every((s: any) => s.isNearby === false)).toBe(true);
    });

    it('should show isEligible = false if customer coordinates are outside Store One delivery radius', async () => {
      // Coordinate far away from Store One (e.g. Bangalore area: 12.9176, 77.6244)
      const res = await request(app)
        .get('/api/v1/stores?lat=12.9176&lng=77.6244&fulfillment=DELIVERY')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      
      const storeOne = res.body.data.find((s: any) => s.storeId === 'STORE-001');
      expect(storeOne).toBeDefined();
      expect(storeOne.isEligible).toBe(false); // ~1200 km is > 15 km radius
    });

    it('should reject customer trying to access an inactive store by ID', async () => {
      const inactiveStore = await prisma.store.findFirst({
        where: { isActive: false },
      });
      if (inactiveStore) {
        const res = await request(app)
          .get(`/api/v1/stores/${inactiveStore.id}`)
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.statusCode).toEqual(404);
        expect(res.body).toHaveProperty('success', false);
      }
    });

    it('should reject customer trying to query products for an inactive store', async () => {
      const inactiveStore = await prisma.store.findFirst({
        where: { isActive: false },
      });
      if (inactiveStore) {
        const res = await request(app)
          .get(`/api/v1/products/store/${inactiveStore.id}`)
          .set('Authorization', `Bearer ${customerToken}`);

        expect(res.statusCode).toEqual(404);
        expect(res.body).toHaveProperty('success', false);
      }
    });
  });

  describe('POST /api/v1/stores (CRUD RBAC)', () => {
    const newStorePayload = {
      storeId: 'TEST-STORE-999',
      name: 'Test Store CRUD',
      address: 'Test Address Line',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9715,
      longitude: 77.5945,
      deliveryRadiusKm: 5.0,
      phone: '+919999999900',
      openingTime: '09:00',
      closingTime: '21:00',
    };

    it('should allow Super Admin to create a new store', async () => {
      const res = await request(app)
        .post('/api/v1/stores')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(newStorePayload);

      expect(res.statusCode).toEqual(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('storeId', 'TEST-STORE-999');

      // Assert audit log was recorded
      const log = await prisma.auditLog.findFirst({
        where: { action: 'CREATE_STORE' },
      });
      expect(log).toBeDefined();
      expect(log?.details).toContain('TEST-STORE-999');
    });

    it('should reject store creation by a Store Manager', async () => {
      const res = await request(app)
        .post('/api/v1/stores')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ ...newStorePayload, storeId: 'TEST-STORE-FAIL' });

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
    });

    it('should reject store creation by a customer', async () => {
      const res = await request(app)
        .post('/api/v1/stores')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ ...newStorePayload, storeId: 'TEST-STORE-FAIL' });

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
    });
  });
});
