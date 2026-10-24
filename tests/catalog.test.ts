import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Category & Product Management (Catalog) Integration Tests', () => {
  let superAdminToken: string;
  let managerToken: string;
  let customerToken: string;

  let centralStoreId: string;
  let testCategoryId: string;
  let testProductId: string;
  
  const testCategoryName = 'Organic Roots';
  const testProductName = 'Organic Baby Carrot';

  beforeAll(async () => {
    // 1. Fetch administrative & customer user details
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
  });

  afterAll(async () => {
    // Clean up created products & categories
    await prisma.cartItem.deleteMany({
      where: { product: { name: testProductName } },
    });
    const ordersToDelete = await prisma.order.findMany({
      where: { items: { some: { product: { name: testProductName } } } }
    });
    const orderIds = ordersToDelete.map(o => o.id);
    if (orderIds.length > 0) {
      await prisma.payment.deleteMany({
        where: { orderId: { in: orderIds } }
      });
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } }
      });
      await prisma.order.deleteMany({
        where: { id: { in: orderIds } }
      });
    }
    await prisma.storeInventory.deleteMany({
      where: { product: { name: testProductName } },
    });
    await prisma.product.deleteMany({
      where: { name: testProductName },
    });
    await prisma.category.deleteMany({
      where: { name: testCategoryName },
    });
    await prisma.$disconnect();
  });

  describe('Category Management CRUD & RBAC Rules', () => {
    it('should reject category creation if token is a Store Manager', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: testCategoryName,
          description: 'Organic root vegetables',
        });

      expect(res.statusCode).toEqual(403);
    });

    it('should allow Super Admin to create a category with description', async () => {
      const res = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: testCategoryName,
          description: 'Organic root vegetables',
          displayOrder: 5,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data).toHaveProperty('name', testCategoryName);
      expect(res.body.data).toHaveProperty('description', 'Organic root vegetables');
      testCategoryId = res.body.data.id;
    });

    it('should allow Super Admin to update category details', async () => {
      const res = await request(app)
        .put(`/api/v1/categories/${testCategoryId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          description: 'Premium organic root vegetables',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveProperty('description', 'Premium organic root vegetables');
    });

    it('should allow Super Admin to deactivate a category (soft delete)', async () => {
      const res = await request(app)
        .delete(`/api/v1/categories/${testCategoryId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveProperty('isActive', false);
    });

    it('should allow Super Admin to activate category back', async () => {
      const res = await request(app)
        .put(`/api/v1/categories/${testCategoryId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          isActive: true,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveProperty('isActive', true);
    });
  });

  describe('Product Management CRUD & RBAC Rules', () => {
    it('should reject product creation if token is a Store Manager', async () => {
      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          name: testProductName,
          categoryId: testCategoryId,
          unit: 'KG',
          price: 150.00,
        });

      expect(res.statusCode).toEqual(403);
    });

    it('should allow Super Admin to create a product with imageUrl', async () => {
      const res = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: testProductName,
          description: 'Sweet organic baby carrots',
          imageUrl: 'https://images.unsplash.com/photo-1590868309235-1e4f73802927',
          categoryId: testCategoryId,
          unit: 'KG',
          price: 150.00,
          mrp: 180.00,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data).toHaveProperty('name', testProductName);
      expect(res.body.data).toHaveProperty('imageUrl', 'https://images.unsplash.com/photo-1590868309235-1e4f73802927');
      testProductId = res.body.data.id;
    });

    it('should write PRODUCT_PRICE_CHANGED audit log when price changes', async () => {
      const res = await request(app)
        .put(`/api/v1/products/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          price: 160.00, // old price was 150
        });

      expect(res.statusCode).toEqual(200);
      expect(Number(res.body.data.price)).toEqual(160.00);

      // Verify audit log entry exists
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PRODUCT_PRICE_CHANGED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
      expect(audit!.details).toContain('160');
    });
  });

  describe('Historical Pricing Preservation & Category/Product Status Restricts', () => {
    let orderId: string;

    it('should allow customer to place a decimal quantity order at the current price', async () => {
      // Allocate stock for test product in Store 1
      await prisma.storeInventory.upsert({
        where: { storeId_productId: { storeId: centralStoreId, productId: testProductId } },
        update: { stockQuantity: 50.0, isAvailable: true },
        create: { storeId: centralStoreId, productId: testProductId, stockQuantity: 50.0, isAvailable: true },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: testProductId, quantity: 1.5 }], // 1.5 KG decimal quantity
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order).toHaveProperty('subtotal', 240); // 1.5 * 160 = 240
      orderId = res.body.data.order.id;

      // Verify productName and unit copied correctly to orderItem
      const item = await prisma.orderItem.findFirst({
        where: { orderId, productId: testProductId },
      });
      expect(item).toBeDefined();
      expect(item!.productName).toEqual(testProductName);
      expect(item!.unit).toEqual('KG');
    });

    it('should preserve original unitPrice inside historical OrderItems when global product price changes', async () => {
      // 1. Super Admin reprices product to 200
      await request(app)
        .put(`/api/v1/products/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          price: 200.00,
        });

      // 2. Fetch historical order item and verify price remains 160
      const item = await prisma.orderItem.findFirst({
        where: { orderId, productId: testProductId },
      });
      expect(Number(item!.unitPrice)).toEqual(160.00);
      expect(Number(item!.totalPrice)).toEqual(240.00);
    });

    it('should block adding product to cart if product isActive is set to false', async () => {
      // 1. Deactivate product
      await request(app)
        .put(`/api/v1/products/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          isActive: false,
        });

      // 2. Attempt to add to cart -> should fail
      const res = await request(app)
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          productId: testProductId,
          quantity: 2.0,
        });

      expect(res.statusCode).toEqual(404);
      expect(res.body).toHaveProperty('errorCode', 'PRODUCT_UNAVAILABLE');
    });

    it('should block adding product to cart if category is set to inactive', async () => {
      // 1. Activate product, but deactivate its category
      await request(app)
        .put(`/api/v1/products/${testProductId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          isActive: true,
        });

      await request(app)
        .put(`/api/v1/categories/${testCategoryId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          isActive: false,
        });

      // 2. Attempt to add to cart -> should fail because category is inactive
      const res = await request(app)
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          productId: testProductId,
          quantity: 1.0,
        });

      expect(res.statusCode).toEqual(404);
      expect(res.body).toHaveProperty('errorCode', 'PRODUCT_UNAVAILABLE');
    });
  });
});
