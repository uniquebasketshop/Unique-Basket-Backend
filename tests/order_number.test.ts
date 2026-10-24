import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import {
  getOrderDateKey,
  formatOrderNumber,
  isValidOrderNumber,
  generateNextOrderNumber,
  ORDER_NUMBER_REGEX,
} from '../src/utils/orderNumber';

describe('Order Number Standardization & Concurrency Tests', () => {
  let customerToken: string;
  let customerId: string;
  let storeId: string;
  let addressId: string;
  let testProductId: string;

  beforeAll(async () => {
    // 1. Seed or fetch user
    const user = await prisma.user.upsert({
      where: { phone: '+919777766661' },
      update: {},
      create: {
        phone: '+919777766661',
        name: 'Order Number Test User',
      },
    });
    customerId = user.id;
    customerToken = generateAccessToken({
      id: customerId,
      role: 'customer',
      phone: user.phone,
    });

    // 2. Fetch Store
    const store = await prisma.store.findFirst({ where: { storeId: 'STORE-001' } });
    if (!store) throw new Error('Store STORE-001 not found.');
    storeId = store.id;

    // 3. Create Address
    const address = await prisma.userAddress.create({
      data: {
        userId: customerId,
        title: 'Home',
        addressLine: '101, Test Residency, Near Central Park',
        city: 'Rajkot',
        state: 'Gujarat',
        pincode: '360001',
        latitude: store.latitude,
        longitude: store.longitude,
        isDefault: true,
      },
    });
    addressId = address.id;

    // 4. Create Product with stock
    const category = await prisma.category.findFirst();
    const product = await prisma.product.create({
      data: {
        name: `Order Num Test Product ${Date.now()}`,
        categoryId: category!.id,
        price: 250.0,
        unit: 'PIECE',
        isActive: true,
      },
    });
    testProductId = product.id;

    await prisma.storeInventory.upsert({
      where: {
        storeId_productId: {
          storeId,
          productId: testProductId,
        },
      },
      update: {
        stockQuantity: 1000,
        isAvailable: true,
      },
      create: {
        storeId,
        productId: testProductId,
        stockQuantity: 1000,
        isAvailable: true,
      },
    });
  });

  describe('1. Format Validation Rules', () => {
    it('should validate standard #UB-DDMMYY-XXX formats as valid', () => {
      expect(isValidOrderNumber('#UB-270926-001')).toBe(true);
      expect(isValidOrderNumber('#UB-270926-002')).toBe(true);
      expect(isValidOrderNumber('#UB-010126-001')).toBe(true);
      expect(isValidOrderNumber('#UB-311225-999')).toBe(true);
      expect(ORDER_NUMBER_REGEX.test('#UB-270926-001')).toBe(true);
      // The 1000th order of a day stays valid
      expect(isValidOrderNumber('#UB-270926-1000')).toBe(true);
      expect(isValidOrderNumber(formatOrderNumber('270926', 1000))).toBe(true);
    });

    it('should reject invalid order number formats', () => {
      expect(isValidOrderNumber('UB-20260927-001')).toBe(false);
      expect(isValidOrderNumber('#UB-20260927001')).toBe(false);
      expect(isValidOrderNumber('#UB-270926-1')).toBe(false);
      expect(isValidOrderNumber('#UB-270926-01')).toBe(false);
      expect(isValidOrderNumber('#UB-270926-0001')).toBe(false);
      expect(isValidOrderNumber('270926-001')).toBe(false);
      expect(isValidOrderNumber('#UB-2709-001')).toBe(false);
    });

    it('should format date key in DDMMYY correctly for known dates', () => {
      // 27 September 2026
      const date1 = new Date('2026-09-27T10:00:00+05:30');
      expect(getOrderDateKey(date1)).toBe('270926');

      // 1 January 2026
      const date2 = new Date('2026-01-01T12:00:00+05:30');
      expect(getOrderDateKey(date2)).toBe('010126');
    });

    it('should format 3-digit zero-padded sequential numbers correctly', () => {
      expect(formatOrderNumber('270926', 1)).toBe('#UB-270926-001');
      expect(formatOrderNumber('270926', 25)).toBe('#UB-270926-025');
      expect(formatOrderNumber('270926', 999)).toBe('#UB-270926-999');
    });
  });

  describe('2. Sequential Progression & Daily Reset', () => {
    it('should generate sequential numbers 001, 002, 003 for the same date', async () => {
      const testDate = new Date('2026-09-27T10:00:00+05:30');
      const testDateKey = getOrderDateKey(testDate);

      // Clear test sequence record and orders if existing for clean test
      await prisma.dailyOrderSequence.deleteMany({
        where: { dateKey: testDateKey },
      });
      const matchingOrders = await prisma.order.findMany({
        where: { orderNumber: { startsWith: `#UB-${testDateKey}-` } },
        select: { id: true },
      });
      if (matchingOrders.length > 0) {
        const orderIds = matchingOrders.map((o) => o.id);
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }

      const num1 = await prisma.$transaction(async (tx) => generateNextOrderNumber(tx, testDate));
      const num2 = await prisma.$transaction(async (tx) => generateNextOrderNumber(tx, testDate));
      const num3 = await prisma.$transaction(async (tx) => generateNextOrderNumber(tx, testDate));

      expect(num1).toBe('#UB-270926-001');
      expect(num2).toBe('#UB-270926-002');
      expect(num3).toBe('#UB-270926-003');
    });

    it('should reset sequence to 001 on a new date', async () => {
      const nextDate = new Date('2026-09-28T10:00:00+05:30');
      const nextDateKey = getOrderDateKey(nextDate);

      // Clear test sequence record if existing
      await prisma.dailyOrderSequence.deleteMany({
        where: { dateKey: nextDateKey },
      });

      const numNextDay = await prisma.$transaction(async (tx) => generateNextOrderNumber(tx, nextDate));
      expect(numNextDay).toBe('#UB-280926-001');
    });
  });

  describe('3. Concurrency Safety & Collision Resistance', () => {
    it('should produce distinct sequential order numbers during simulated concurrent creations', async () => {
      const testConcurDate = new Date('2026-09-29T10:00:00+05:30');
      const dateKey = getOrderDateKey(testConcurDate);

      await prisma.dailyOrderSequence.deleteMany({
        where: { dateKey },
      });

      // Launch 10 concurrent requests to generate next order number
      const promises = Array.from({ length: 10 }, () =>
        prisma.$transaction(async (tx) => generateNextOrderNumber(tx, testConcurDate))
      );

      const results = await Promise.all(promises);

      // Verify all 10 are distinct
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(10);

      // Verify each result matches expected pattern
      for (const res of results) {
        expect(isValidOrderNumber(res)).toBe(true);
        expect(res.startsWith('#UB-290926-')).toBe(true);
      }
    });

    it('should enforce database uniqueness on orderNumber column', async () => {
      const uniqueOrderNumber = `#UB-999999-001`;

      // Clean up any existing
      await prisma.order.deleteMany({
        where: { orderNumber: uniqueOrderNumber },
      });

      // Create first order with unique number
      await prisma.order.create({
        data: {
          orderNumber: uniqueOrderNumber,
          userId: customerId,
          storeId,
          fulfillmentType: 'DELIVERY',
          addressId,
          subtotal: 250.0,
          deliveryFee: 0.0,
          total: 250.0,
          paymentMethod: 'COD',
        },
      });

      // Attempt creating a duplicate order with the same orderNumber must throw
      await expect(
        prisma.order.create({
          data: {
            orderNumber: uniqueOrderNumber,
            userId: customerId,
            storeId,
            fulfillmentType: 'DELIVERY',
            addressId,
            subtotal: 250.0,
            deliveryFee: 0.0,
            total: 250.0,
            paymentMethod: 'COD',
          },
        })
      ).rejects.toThrow();

      // Clean up
      await prisma.order.deleteMany({
        where: { orderNumber: uniqueOrderNumber },
      });
    });
  });

  describe('4. Full End-to-End API Integration', () => {
    it('should return standardized orderNumber upon POST /api/v1/orders', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId,
          storeId,
          paymentMethod: 'COD',
          items: [
            {
              productId: testProductId,
              quantity: 1,
            },
          ],
        });

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.order).toHaveProperty('orderNumber');

      const generatedNumber = res.body.data.order.orderNumber;
      expect(isValidOrderNumber(generatedNumber)).toBe(true);
      expect(generatedNumber).toMatch(/^#UB-\d{6}-\d{3}$/);

      // Verify GET /api/v1/orders/:id returns the exact same orderNumber
      const getRes = await request(app)
        .get(`/api/v1/orders/${res.body.data.order.id}`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(getRes.statusCode).toBe(200);
      expect(getRes.body.data.orderNumber).toBe(generatedNumber);
    });
  });
});
