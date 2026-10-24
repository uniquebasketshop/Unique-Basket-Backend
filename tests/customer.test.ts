import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Customer Management Integration Tests', () => {
  let superAdminToken: string;
  let managerToken: string;
  let activeCustomerToken: string;
  let deactivatedCustomerToken: string;

  let activeCustomerId: string;
  let deactivatedCustomerId: string;
  let centralStoreId: string;
  let testProductId: string;

  const activePhone = '+919888877771';
  const deactivatedPhone = '+919888877772';

  beforeAll(async () => {
    // 1. Fetch Super Admin & Store Manager
    const superAdmin = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });
    superAdminToken = generateAccessToken({
      id: superAdmin!.id,
      role: 'SUPER_ADMIN',
      email: superAdmin!.email,
    });

    const manager = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    managerToken = generateAccessToken({
      id: manager!.id,
      role: 'STORE_MANAGER',
      email: manager!.email,
      storeId: manager!.managers[0].storeId,
    });

    // 2. Fetch Store & Product
    const store = await prisma.store.findFirst({ where: { storeId: 'STORE-001' } });
    centralStoreId = store!.id;

    await prisma.product.deleteMany({ where: { name: 'Customer Module Test Guava' } });
    await prisma.category.deleteMany({ where: { name: 'Customer Test Category' } });

    const category = await prisma.category.create({
      data: { name: 'Customer Test Category', description: 'Testing category' },
    });
    const product = await prisma.product.create({
      data: {
        name: 'Customer Module Test Guava',
        categoryId: category.id,
        unit: 'KG',
        price: 120.0,
      },
    });
    testProductId = product.id;

    await prisma.storeInventory.upsert({
      where: { storeId_productId: { storeId: centralStoreId, productId: testProductId } },
      update: { stockQuantity: 100.0, isAvailable: true },
      create: { storeId: centralStoreId, productId: testProductId, stockQuantity: 100.0, isAvailable: true },
    });

    // 3. Create active customer
    const activeCustomer = await prisma.user.upsert({
      where: { phone: activePhone },
      update: { isActive: true },
      create: {
        phone: activePhone,
        name: 'Active Test Customer',
        email: 'active@customer.com',
        isActive: true,
      },
    });
    activeCustomerId = activeCustomer.id;
    activeCustomerToken = generateAccessToken({
      id: activeCustomerId,
      role: 'customer',
      email: activePhone,
    });

    // Add address for active customer
    await prisma.userAddress.create({
      data: {
        userId: activeCustomerId,
        title: 'Home Address',
        addressLine: 'Nana Mava Road',
        city: 'Rajkot',
        state: 'Gujarat',
        pincode: '360005',
        latitude: 22.308155,
        longitude: 70.800705,
        isDefault: true,
      },
    });

    // Place an order for active customer
    const order = await prisma.order.create({
      data: {
        orderNumber: 'UB-CUST-TEST-001',
        userId: activeCustomerId,
        storeId: centralStoreId,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'COD',
        subtotal: 240.0,
        deliveryFee: 0.0,
        discount: 0.0,
        total: 240.0,
        orderStatus: 'DELIVERED',
        paymentStatus: 'PAID',
      },
    });

    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: testProductId,
        productName: 'Customer Module Test Guava',
        unit: 'KG',
        quantity: 2.0,
        unitPrice: 120.0,
        totalPrice: 240.0,
      },
    });

    // 4. Create deactivated customer
    const deactivatedCustomer = await prisma.user.upsert({
      where: { phone: deactivatedPhone },
      update: { isActive: false },
      create: {
        phone: deactivatedPhone,
        name: 'Deactivated Customer',
        email: 'deactive@customer.com',
        isActive: false,
      },
    });
    deactivatedCustomerId = deactivatedCustomer.id;
    deactivatedCustomerToken = generateAccessToken({
      id: deactivatedCustomerId,
      role: 'customer',
      email: deactivatedPhone,
    });
  });

  afterAll(async () => {
    // Teardown
    const userIds = [activeCustomerId, deactivatedCustomerId].filter(Boolean);
    const orders = await prisma.order.findMany({
      where: { userId: { in: userIds } },
    });
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length > 0) {
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }

    await prisma.userAddress.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.storeInventory.deleteMany({ where: { productId: testProductId } });
    await prisma.product.deleteMany({ where: { id: testProductId } });
    await prisma.category.deleteMany({ where: { name: 'Customer Test Category' } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe('Customer Read Operations & Security Isolation', () => {
    it('should allow Super Admin to list customers', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.customers)).toBe(true);
      expect(res.body.data).toHaveProperty('pagination');
    });

    it('should filter customers by search query (phone or name)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ search: 'Active Test' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.customers.length).toBeGreaterThan(0);
      expect(res.body.data.customers[0]).toHaveProperty('name', 'Active Test Customer');
    });

    it('should search customers by phone number', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ search: activePhone });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.customers.length).toBe(1);
      expect(res.body.data.customers[0].phone).toEqual(activePhone);
    });

    it('should sort customers by most orders and highest spending', async () => {
      // Test sort by orders_desc
      const ordersRes = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ sortBy: 'orders_desc' });

      expect(ordersRes.statusCode).toEqual(200);
      expect(ordersRes.body.data.customers[0].orderCount).toBeGreaterThanOrEqual(
        ordersRes.body.data.customers[ordersRes.body.data.customers.length - 1].orderCount
      );

      // Test sort by spend_desc
      const spendRes = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ sortBy: 'spend_desc' });

      expect(spendRes.statusCode).toEqual(200);
      expect(spendRes.body.data.customers[0].totalSpent).toBeGreaterThanOrEqual(
        spendRes.body.data.customers[spendRes.body.data.customers.length - 1].totalSpent
      );
    });

    it('should filter customers by account status (ACTIVE / INACTIVE)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ status: 'INACTIVE' });

      expect(res.statusCode).toEqual(200);
      const deactives = res.body.data.customers.filter((c: any) => c.phone === deactivatedPhone);
      expect(deactives.length).toBe(1);
      expect(deactives[0].isActive).toBe(false);
    });

    it('should block Store Manager from accessing global customer management (403 Forbidden)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.statusCode).toEqual(403);
    });
  });

  describe('Customer Details, Addresses, Order History & Statistics', () => {
    it('should retrieve full customer profile, saved addresses, order history, and stats', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${activeCustomerId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.customer).toHaveProperty('phone', activePhone);

      // Verify stats
      expect(res.body.data.stats).toHaveProperty('totalOrders', 1);
      expect(res.body.data.stats).toHaveProperty('completedOrders', 1);
      expect(res.body.data.stats).toHaveProperty('totalSpent', 240);

      // Verify saved addresses
      expect(res.body.data.addresses.length).toBeGreaterThan(0);
      expect(res.body.data.addresses[0]).toHaveProperty('title', 'Home Address');

      // Verify historical order preserves orderStatus and paymentStatus independently
      expect(res.body.data.orders.length).toBeGreaterThan(0);
      expect(res.body.data.orders[0]).toHaveProperty('orderStatus', 'DELIVERED');
      expect(res.body.data.orders[0]).toHaveProperty('paymentStatus', 'PAID');
    });
  });

  describe('Customer Status Management & Deactivation Enforcement', () => {
    it('should allow Super Admin to deactivate a customer account and write audit log', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/customers/${activeCustomerId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isActive: false });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.isActive).toBe(false);

      // Verify Audit Log entry exists
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'CUSTOMER_DEACTIVATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
    });

    it('should immediately reject order checkout attempts from deactivated customer (401 ACCOUNT_DEACTIVATED)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${activeCustomerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: testProductId, quantity: 1.0 }],
        });

      expect(res.statusCode).toEqual(401);
      expect(res.body).toHaveProperty('errorCode', 'ACCOUNT_DEACTIVATED');
    });

    it('should preserve historical orders intact when customer is deactivated', async () => {
      const order = await prisma.order.findFirst({
        where: { userId: activeCustomerId },
      });

      expect(order).toBeDefined();
      expect(order!.orderNumber).toEqual('UB-CUST-TEST-001');
      expect(Number(order!.total)).toEqual(240);
    });

    it('should allow Super Admin to activate customer account back', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/customers/${activeCustomerId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isActive: true });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.isActive).toBe(true);
    });
  });
});
