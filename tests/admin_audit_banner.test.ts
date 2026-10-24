import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Admin System Audit Logs & Marketing Banners Integration Tests', () => {
  let superAdminToken: string;
  let managerToken: string;
  let superAdminId: string;
  let testBannerId: string;

  beforeAll(async () => {
    // 1. Fetch seeded Super Admin and Store Manager
    const superAdmin = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });

    const manager = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });

    if (!superAdmin || !manager) {
      throw new Error('Seed admin users not found.');
    }

    superAdminId = superAdmin.id;

    superAdminToken = generateAccessToken({
      id: superAdmin.id,
      role: 'SUPER_ADMIN',
      email: superAdmin.email,
    });

    managerToken = generateAccessToken({
      id: manager.id,
      role: 'STORE_MANAGER',
      email: manager.email,
      storeId: manager.managers[0]?.storeId,
    });

    // Create a known sample audit log for verification
    await prisma.auditLog.create({
      data: {
        adminUserId: superAdmin.id,
        action: 'TEST_AUDIT_ACTION_INIT',
        details: 'Sample audit record created for integration testing.',
      },
    });
  });

  afterAll(async () => {
    // Clean up banners and audit logs created during test
    if (testBannerId) {
      await prisma.banner.deleteMany({ where: { id: testBannerId } });
    }
    await prisma.banner.deleteMany({
      where: { title: { contains: 'Test Banner' } },
    });
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['TEST_AUDIT_ACTION_INIT', 'CREATE_BANNER', 'UPDATE_BANNER', 'DEACTIVATE_BANNER', 'DELETE_BANNER'] } },
    });
    await prisma.$disconnect();
  });

  describe('System Audit Logs Module', () => {
    it('should reject unauthenticated audit log requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs');
      expect(res.statusCode).toEqual(401);
    });

    it('should reject Store Manager attempting to view audit logs with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
    });

    it('should allow Super Admin to fetch paginated audit logs', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ page: 1, limit: 10 });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('auditLogs');
      expect(res.body.data).toHaveProperty('pagination');
      expect(Array.isArray(res.body.data.auditLogs)).toBe(true);
      expect(res.body.data.auditLogs.length).toBeGreaterThan(0);

      // Verify no sensitive fields (e.g. passwordHash) are returned
      const sample = res.body.data.auditLogs[0];
      expect(sample).toHaveProperty('id');
      expect(sample).toHaveProperty('action');
      expect(sample).toHaveProperty('createdAt');
      if (sample.adminUser) {
        expect(sample.adminUser).not.toHaveProperty('passwordHash');
      }
    });

    it('should filter audit logs by search query and action', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ search: 'TEST_AUDIT_ACTION_INIT' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.auditLogs.length).toBeGreaterThan(0);
      expect(res.body.data.auditLogs[0].action).toEqual('TEST_AUDIT_ACTION_INIT');
    });

    it('should allow Super Admin to fetch distinct audit actions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs/actions')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toContain('TEST_AUDIT_ACTION_INIT');
    });
  });

  describe('Marketing Banners Module', () => {
    it('should reject unauthenticated banner requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/banners');
      expect(res.statusCode).toEqual(401);
    });

    it('should reject Store Manager attempting to create a banner with 403', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          title: 'Store Manager Banner Attempt',
          imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e',
        });

      expect(res.statusCode).toEqual(403);
    });

    it('should reject banner creation without image URL (400)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Missing Image Banner',
          imageUrl: '',
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'IMAGE_URL_REQUIRED');
    });

    it('should allow Super Admin to create a new banner (201)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/banners')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Test Banner - Summer Grocery Festival',
          imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e',
          displayOrder: 1,
          isActive: true,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.title).toEqual('Test Banner - Summer Grocery Festival');
      expect(res.body.data.isActive).toBe(true);

      testBannerId = res.body.data.id;

      // Verify audit log created
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'CREATE_BANNER', details: { contains: testBannerId } },
      });
      expect(audit).toBeDefined();
    });

    it('should allow Super Admin to list banners with pagination & filtering', async () => {
      const res = await request(app)
        .get('/api/v1/admin/banners')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ page: 1, limit: 10, status: 'ACTIVE' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('banners');
      expect(res.body.data).toHaveProperty('pagination');
      expect(res.body.data.banners.some((b: any) => b.id === testBannerId)).toBe(true);
    });

    it('should allow Super Admin to fetch banner details by ID', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/banners/${testBannerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.id).toEqual(testBannerId);
    });

    it('should allow Super Admin to update banner details', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/banners/${testBannerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          title: 'Test Banner - Monsoon Mega Sale',
          displayOrder: 2,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.title).toEqual('Test Banner - Monsoon Mega Sale');
      expect(res.body.data.displayOrder).toEqual(2);

      // Verify audit log
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'UPDATE_BANNER', details: { contains: testBannerId } },
      });
      expect(audit).toBeDefined();
    });

    it('should allow Super Admin to deactivate a banner (soft-delete)', async () => {
      const res = await request(app)
        .delete(`/api/v1/admin/banners/${testBannerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.isActive).toBe(false);

      // Verify in database
      const dbBanner = await prisma.banner.findUnique({ where: { id: testBannerId } });
      expect(dbBanner?.isActive).toBe(false);

      // Verify audit log
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'DEACTIVATE_BANNER', details: { contains: testBannerId } },
      });
      expect(audit).toBeDefined();
    });

    it('should reject Store Manager attempting to update or delete banners (403)', async () => {
      const updateRes = await request(app)
        .put(`/api/v1/admin/banners/${testBannerId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ title: 'Unauthorized Manager Update' });
      expect(updateRes.statusCode).toEqual(403);

      const deleteRes = await request(app)
        .delete(`/api/v1/admin/banners/${testBannerId}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(deleteRes.statusCode).toEqual(403);
    });
  });
});
