import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Device Token Registration & Push Notifications Integration Tests', () => {
  let customerToken: string;
  let customerId: string;
  let managerToken: string;
  let managerId: string;

  beforeAll(async () => {
    // 1. Customer setup
    const user = await prisma.user.upsert({
      where: { phone: '+919999999999' },
      update: {},
      create: { phone: '+919999999999', name: 'Notify Customer' },
    });
    customerId = user.id;

    customerToken = generateAccessToken({
      id: user.id,
      role: 'customer',
      phone: user.phone,
    });

    // 2. Manager setup
    const managerUser = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });

    if (!managerUser) {
      throw new Error('manager1@uniquebasket.com not found.');
    }

    managerId = managerUser.id;
    managerToken = generateAccessToken({
      id: managerUser.id,
      role: 'STORE_MANAGER',
      email: managerUser.email,
      storeId: managerUser.managers[0]?.storeId,
    });

    // Clean up pre-existing test tokens
    await prisma.deviceToken.deleteMany({
      where: { token: { in: ['mock_customer_token_fcm', 'mock_manager_token_fcm'] } },
    });
  });

  afterAll(async () => {
    await prisma.deviceToken.deleteMany({
      where: { token: { in: ['mock_customer_token_fcm', 'mock_manager_token_fcm'] } },
    });
    await prisma.$disconnect();
  });

  describe('Device Token Registration', () => {
    it('should successfully register a customer device token', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/tokens')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          token: 'mock_customer_token_fcm',
          platform: 'ANDROID',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('userId', customerId);
      expect(res.body.data).toHaveProperty('adminUserId', null);
    });

    it('should successfully register a store manager device token', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/tokens')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          token: 'mock_manager_token_fcm',
          platform: 'IOS',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('userId', null);
      expect(res.body.data).toHaveProperty('adminUserId', managerId);
    });

    it('should reject token registration if parameters are missing or invalid', async () => {
      const res = await request(app)
        .post('/api/v1/notifications/tokens')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          token: '',
          platform: 'INVALID_PLATFORM_NAME',
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'MISSING_PARAMETERS');
    });
  });

  describe('Customer In-App Notifications Inbox', () => {
    let createdNotificationId: string;
    let otherCustomerToken: string;

    beforeAll(async () => {
      // Create another customer for ownership isolation tests
      const otherUser = await prisma.user.upsert({
        where: { phone: '+918888888888' },
        update: {},
        create: { phone: '+918888888888', name: 'Other Customer' },
      });

      otherCustomerToken = generateAccessToken({
        id: otherUser.id,
        role: 'customer',
        phone: otherUser.phone,
      });

      // Clear notifications for test user
      await prisma.notification.deleteMany({
        where: { userId: customerId },
      });
    });

    it('should persist notification and retrieve it via GET /api/v1/notifications', async () => {
      // 1. Create notification via NotificationService (simulating order update)
      await prisma.notification.create({
        data: {
          userId: customerId,
          title: 'Your order is being prepared',
          body: "We're packing your fresh avocados, kale & sourdough bread at Nana Mova Road store.",
          type: 'ORDER_STATUS',
          orderNumber: '#UB-20260908-015',
          tag: '#UB-20260908-015',
          actionText: 'Track Live Order →',
          isRead: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].title).toBe('Your order is being prepared');
      expect(res.body.data[0].isRead).toBe(false);
      expect(res.body.meta.unreadCount).toBeGreaterThanOrEqual(1);

      createdNotificationId = res.body.data[0].id;
    });

    it('should return correct unread count via GET /api/v1/notifications/unread-count', async () => {
      const res = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.unreadCount).toBeGreaterThanOrEqual(1);
    });

    it('should mark a single notification as read via PATCH /api/v1/notifications/:id/read', async () => {
      const res = await request(app)
        .patch(`/api/v1/notifications/${createdNotificationId}/read`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRead).toBe(true);
    });

    it('should prevent another customer from marking foreign notification as read (Ownership Enforcement)', async () => {
      const res = await request(app)
        .patch(`/api/v1/notifications/${createdNotificationId}/read`)
        .set('Authorization', `Bearer ${otherCustomerToken}`);

      expect(res.statusCode).toEqual(403);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should mark all customer notifications as read via PATCH /api/v1/notifications/read-all', async () => {
      // Add another unread notification
      await prisma.notification.create({
        data: {
          userId: customerId,
          title: 'Fresh deals are waiting for you',
          body: 'Save up to ₹100 on farm-fresh organic produce.',
          type: 'PROMOTION',
          promoCode: 'FRESH100',
          isRead: false,
        },
      });

      const markAllRes = await request(app)
        .patch('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(markAllRes.statusCode).toEqual(200);
      expect(markAllRes.body.success).toBe(true);

      // Verify unread count is now 0
      const countRes = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(countRes.body.data.unreadCount).toBe(0);
    });
  });
});
