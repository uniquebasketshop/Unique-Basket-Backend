import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Store Inventory Management Integration Tests', () => {
  let superAdminToken: string;
  let manager1Token: string;
  let manager2Token: string;
  let customerToken: string;

  let store1Id: string;
  let store2Id: string;
  let testProductId: string;

  const testProductName = 'Organic Inventory Apples';

  beforeAll(async () => {
    // 1. Fetch Admin and Customer credentials
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

    const manager2 = await prisma.adminUser.findUnique({
      where: { email: 'manager2@uniquebasket.com' },
      include: { managers: true },
    });
    manager2Token = generateAccessToken({
      id: manager2!.id,
      role: 'STORE_MANAGER',
      email: manager2!.email,
      storeId: manager2!.managers[0].storeId,
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

    // 2. Fetch Stores
    const store1 = await prisma.store.findFirst({ where: { storeId: 'STORE-001' } });
    store1Id = store1!.id;

    const store2 = await prisma.store.findFirst({ where: { storeId: 'STORE-002' } });
    store2Id = store2!.id;

    // 3. Create active Category & Product
    const category = await prisma.category.create({
      data: { name: 'Inventory Fruits', description: 'Fresh fruits' },
    });

    const product = await prisma.product.create({
      data: {
        name: testProductName,
        categoryId: category.id,
        unit: 'KG',
        price: 100.0,
      },
    });
    testProductId = product.id;
  });

  afterAll(async () => {
    // Teardown relations
    await prisma.cartItem.deleteMany({ where: { productId: testProductId } });
    
    const orders = await prisma.order.findMany({
      where: { items: { some: { productId: testProductId } } },
    });
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length > 0) {
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }

    await prisma.inventoryTransaction.deleteMany({ where: { productId: testProductId } });
    await prisma.storeInventory.deleteMany({ where: { productId: testProductId } });
    await prisma.product.deleteMany({ where: { id: testProductId } });
    await prisma.category.deleteMany({ where: { name: 'Inventory Fruits' } });
    await prisma.$disconnect();
  });

  describe('Inventory Read Operations & Isolation Limits', () => {
    it('should allow Super Admin to query inventory details for any store', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${store1Id}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('should allow Store Manager 1 to query inventory of their assigned store (STORE-001)', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${store1Id}`)
        .set('Authorization', `Bearer ${manager1Token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
    });

    it('should block Store Manager 1 from querying inventory of STORE-002 (403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${store2Id}`)
        .set('Authorization', `Bearer ${manager1Token}`);

      expect(res.statusCode).toEqual(403);
    });
  });

  describe('Inventory Update Security & Concurrency Rules', () => {
    it('should allow Super Admin to update stock for any store (STORE-002)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${store2Id}/inventory/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          stockQuantity: 15.5,
          lowStockThreshold: 3.0,
        });

      expect(res.statusCode).toEqual(200);
      expect(Number(res.body.data.stockQuantity)).toEqual(15.5);
    });

    it('should allow Store Manager 1 to update stock for their assigned store (STORE-001)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${store1Id}/inventory/${testProductId}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          stockQuantity: 25.0,
        });

      expect(res.statusCode).toEqual(200);
      expect(Number(res.body.data.stockQuantity)).toEqual(25.0);
    });

    it('should block Store Manager 1 from updating stock for STORE-002 (403 Forbidden)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${store2Id}/inventory/${testProductId}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          stockQuantity: 40.0,
        });

      expect(res.statusCode).toEqual(403);
    });

    it('should write an InventoryTransaction history record on manual updates', async () => {
      // 1. Super Admin resets stock using the new Adjustment UI payload format
      const res = await request(app)
        .put(`/api/v1/products/store/${store1Id}/inventory/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          adjustmentType: 'SET',
          quantity: 30.5, // decimal value
          reason: 'Initial load audit',
        });

      expect(res.statusCode).toEqual(200);
      expect(Number(res.body.data.stockQuantity)).toEqual(30.5);

      // 2. Query history list and verify transaction log matches
      const txRes = await request(app)
        .get('/api/v1/admin/inventory/transactions')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ storeId: store1Id, productId: testProductId });

      expect(txRes.statusCode).toEqual(200);
      expect(txRes.body.data.length).toBeGreaterThan(0);
      expect(txRes.body.data[0]).toHaveProperty('type', 'STOCK_ADJUSTED');
      expect(Number(txRes.body.data[0].newQuantity)).toEqual(30.5);
    });

    it('should atomically block adjustments that would cause negative stock (400 Bad Request)', async () => {
      const res = await request(app)
        .put(`/api/v1/products/store/${store1Id}/inventory/${testProductId}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          adjustmentType: 'REMOVE',
          quantity: 40.0, // current is 30.5, so this would be -9.5
          reason: 'Damaged item checkout removal',
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'NEGATIVE_STOCK_BLOCKED');
    });
  });

  describe('Order Deductions & Cancellation Restores', () => {
    let orderId: string;

    it('should atomically deduct inventory stock during checkout and record transaction history', async () => {
      // Current stock is 30.5 KG
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: store1Id,
          paymentMethod: 'COD',
          items: [{ productId: testProductId, quantity: 5.5 }], // deduct 5.5 KG
        });

      expect(res.statusCode).toEqual(201);
      orderId = res.body.data.order.id;

      // Verify stock quantity is now 25.0
      const current = await prisma.storeInventory.findUnique({
        where: { storeId_productId: { storeId: store1Id, productId: testProductId } },
      });
      expect(Number(current!.stockQuantity)).toEqual(25.0);

      // Verify transaction history logged
      const tx = await prisma.inventoryTransaction.findFirst({
        where: { productId: testProductId, type: 'ORDER_DEDUCTION' },
        orderBy: { createdAt: 'desc' },
      });
      expect(tx).toBeDefined();
      expect(Number(tx!.changeQuantity)).toEqual(-5.5);
      expect(Number(tx!.newQuantity)).toEqual(25.0);
    });

    it('should restore inventory stock upon order cancellation and log cancel history', async () => {
      // Cancel the order
      // Use admin endpoint to cancel the order and trigger inventory restoration
      const res = await request(app)
        .put(`/api/v1/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.statusCode).toEqual(200);

      // Verify stock quantity restored back to 30.5 KG
      const current = await prisma.storeInventory.findUnique({
        where: { storeId_productId: { storeId: store1Id, productId: testProductId } },
      });
      expect(Number(current!.stockQuantity)).toEqual(30.5);

      // Verify cancellation transaction history logged
      const tx = await prisma.inventoryTransaction.findFirst({
        where: { productId: testProductId, type: 'ORDER_CANCELLATION_RESTORE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(tx).toBeDefined();
      expect(Number(tx!.changeQuantity)).toEqual(5.5);
      expect(Number(tx!.newQuantity)).toEqual(30.5);
    });
  });
});
