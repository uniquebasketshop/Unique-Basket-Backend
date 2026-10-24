import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { FakeCashfree, installFakeCashfree } from './support/fakeCashfree';

describe('Fares & COD Settings Integration Tests', () => {
  // ONLINE orders need a configured gateway; the fake answers Cashfree calls in memory
  let fakeCashfree: FakeCashfree;
  let superAdminToken: string;
  let managerToken: string;
  let customerToken: string;
  let customerId: string;
  let centralStoreId: string;
  let appleProductId: string;
  let customerAddressId: string;

  beforeAll(async () => {
    fakeCashfree = installFakeCashfree();
    // 1. Fetch seed users
    const superAdmin = await prisma.adminUser.findUnique({
      where: { email: 'superadmin@uniquebasket.com' },
    });
    const manager = await prisma.adminUser.findUnique({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });

    if (!superAdmin || !manager) throw new Error('Seeded admin users missing.');

    const user = await prisma.user.upsert({
      where: { phone: '+919888877777' },
      update: {},
      create: { phone: '+919888877777', name: 'Fare COD Test User' },
    });
    customerId = user.id;

    // Create a delivery address close to Store One (Rajkot lat: 22.308155, lng: 70.800705)
    const address = await prisma.userAddress.create({
      data: {
        userId: customerId,
        title: 'Home',
        addressLine: 'Nana Mava Road',
        city: 'Rajkot',
        state: 'Gujarat',
        pincode: '360005',
        latitude: 22.308000,
        longitude: 70.800000,
      },
    });
    customerAddressId = address.id;

    const centralStore = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    if (!centralStore) throw new Error('Central Store missing.');
    centralStoreId = centralStore.id;

    const apple = await prisma.product.findFirst({ where: { name: { startsWith: 'Apple' } } });
    if (!apple) throw new Error('Apple product missing.');
    appleProductId = apple.id;

    // Reset stock to 100
    await prisma.storeInventory.updateMany({
      where: { productId: appleProductId },
      data: { stockQuantity: 100.0, isAvailable: true },
    });

    // Generate tokens
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

    customerToken = generateAccessToken({
      id: user.id,
      role: 'customer',
      phone: user.phone,
    });
  });

  beforeEach(async () => {
    // Reset delivery settings to standard defaults before each test
    const current = await prisma.deliverySettings.findFirst();
    await prisma.deliverySettings.upsert({
      where: { id: current?.id || '00000000-0000-0000-0000-000000000000' },
      update: {
        deliveryEnabled: true,
        deliveryFee: 30.0,
        freeDeliveryThreshold: 200.0,
        minimumOrderAmount: 199.0,
        codEnabled: true,
        codCharge: 20.0,
        minimumCodOrderAmount: 100.0,
        maximumCodOrderAmount: 5000.0,
        pickupCodEnabled: true,
      },
      create: {
        deliveryEnabled: true,
        deliveryFee: 30.0,
        freeDeliveryThreshold: 200.0,
        minimumOrderAmount: 199.0,
        codEnabled: true,
        codCharge: 20.0,
        minimumCodOrderAmount: 100.0,
        maximumCodOrderAmount: 5000.0,
        pickupCodEnabled: true,
      },
    });

    // Ensure inventory has stock
    await prisma.storeInventory.updateMany({
      where: { productId: appleProductId },
      data: { stockQuantity: 100.0, isAvailable: true },
    });
  });

  afterAll(async () => {
    fakeCashfree.restore();
    // Restore default settings
    await prisma.deliverySettings.updateMany({
      data: {
        deliveryEnabled: true,
        deliveryFee: 30.0,
        freeDeliveryThreshold: 200.0,
        minimumOrderAmount: 199.0,
        codEnabled: true,
        codCharge: 20.0,
        minimumCodOrderAmount: 100.0,
        maximumCodOrderAmount: 5000.0,
        pickupCodEnabled: true,
      },
    });
  });

  // 1 & 2. Super Admin Read & Update
  describe('RBAC & Settings Management API', () => {
    it('1. SUPER_ADMIN can read fare & COD settings', async () => {
      const res = await request(app)
        .get('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('deliveryEnabled', true);
      expect(res.body.data).toHaveProperty('deliveryFee', 30);
      expect(res.body.data).toHaveProperty('freeDeliveryThreshold', 200);
      expect(res.body.data).toHaveProperty('minimumOrderAmount', 199);
      expect(res.body.data).toHaveProperty('codEnabled', true);
      expect(res.body.data).toHaveProperty('codCharge', 20);
      expect(res.body.data).toHaveProperty('minimumCodOrderAmount', 100);
      expect(res.body.data).toHaveProperty('maximumCodOrderAmount', 5000);
      expect(res.body.data).toHaveProperty('pickupCodEnabled', true);
    });

    it('2. SUPER_ADMIN can update fare & COD settings', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          deliveryEnabled: true,
          deliveryFee: 40,
          freeDeliveryThreshold: 600,
          minimumOrderAmount: 250,
          codEnabled: true,
          codCharge: 25,
          minimumCodOrderAmount: 150,
          maximumCodOrderAmount: 4000,
          pickupCodEnabled: false,
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryFee).toBe(40);
      expect(res.body.data.freeDeliveryThreshold).toBe(600);
      expect(res.body.data.minimumOrderAmount).toBe(250);
      expect(res.body.data.codCharge).toBe(25);
      expect(res.body.data.pickupCodEnabled).toBe(false);
    });

    it('3. STORE_MANAGER receives 403 when trying to access or update settings', async () => {
      const getRes = await request(app)
        .get('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${managerToken}`);
      expect(getRes.statusCode).toEqual(403);

      const putRes = await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ deliveryFee: 50 });
      expect(putRes.statusCode).toEqual(403);
    });

    it('4. Invalid negative values are rejected with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ deliveryFee: -10 });

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('NEGATIVE_VALUES_NOT_ALLOWED');
    });

    it('5. Invalid COD range (min > max) is rejected with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ minimumCodOrderAmount: 6000, maximumCodOrderAmount: 5000 });

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('INVALID_COD_RANGE');
    });

    it('20. Audit log FARE_COD_SETTINGS_UPDATED is created on successful update', async () => {
      await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ deliveryFee: 45, codCharge: 15 });

      const log = await prisma.auditLog.findFirst({
        where: { action: 'FARE_COD_SETTINGS_UPDATED' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
      expect(log?.details).toContain('45');
    });
  });

  // Delivery business rules
  describe('Delivery Business Rules Enforcement', () => {
    it('6. Delivery disabled prevents DELIVERY order creation', async () => {
      // Disable delivery
      await prisma.deliverySettings.updateMany({
        data: { deliveryEnabled: false },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 2 }], // 2 * 180 = 360
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('DELIVERY_DISABLED');
      expect(res.body.message).toBe('Delivery orders are currently unavailable.');
    });

    it('7. Pickup remains available when delivery is disabled', async () => {
      await prisma.deliverySettings.updateMany({
        data: { deliveryEnabled: false },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order.fulfillmentType).toBe('PICKUP');
    });

    it('8. Minimum delivery amount is enforced (order below minimum is rejected)', async () => {
      // Minimum is 199. 1 Apple = 180 (< 199)
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 1 }], // 180 < 199
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('MINIMUM_DELIVERY_AMOUNT_NOT_MET');
    });

    it('9. Free delivery threshold applies correctly (subtotal >= threshold -> deliveryFee = 0)', async () => {
      // Free threshold is 200 (D-009). 3 Apples = 3 * 180 = 540 (>= 200)
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 3 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.subtotal).toBe(540);
      expect(res.body.data.order.deliveryFee).toBe(0);
      expect(res.body.data.order.total).toBe(540);
    });

    it('10. Delivery fee applies when subtotal is below free delivery threshold', async () => {
      // Fee mechanism with an admin-configured higher threshold:
      // 2 Apples = 360 (>= 199 minimum, but < 1000 threshold). Delivery fee = 30.
      await prisma.deliverySettings.updateMany({ data: { freeDeliveryThreshold: 1000 } });
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.subtotal).toBe(360);
      expect(res.body.data.order.deliveryFee).toBe(30);
      expect(res.body.data.order.total).toBe(390); // 360 + 30
    });

    it('11. Pickup delivery fee is always 0', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 1 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.deliveryFee).toBe(0);
    });
  });

  // COD business rules
  describe('Cash on Delivery (COD) Business Rules Enforcement', () => {
    it('12. COD disabled prevents delivery COD order', async () => {
      await prisma.deliverySettings.updateMany({
        data: { codEnabled: false },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('COD_DISABLED');
    });

    it('13. Pay at Store stays available for pickup even with the COD switches off (D-018)', async () => {
      await prisma.deliverySettings.updateMany({
        data: { codEnabled: false, pickupCodEnabled: false },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.paymentMethod).toBe('COD');
      expect(res.body.data.order.codCharge).toBe(0);
      expect(res.body.data.order.total).toBe(res.body.data.order.subtotal);
    });

    it('14. COD minimum order amount is enforced', async () => {
      // Set min COD to 400. Subtotal 2 Apples = 360 (< 400).
      await prisma.deliverySettings.updateMany({
        data: { minimumCodOrderAmount: 400 },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('MINIMUM_COD_AMOUNT_NOT_MET');
    });

    it('15. COD maximum order amount is enforced', async () => {
      // Set max COD to 300. Subtotal 2 Apples = 360 (> 300).
      await prisma.deliverySettings.updateMany({
        data: { maximumCodOrderAmount: 300 },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('MAXIMUM_COD_AMOUNT_EXCEEDED');
    });

    it('16. COD charge applied correctly to total order amount', async () => {
      // Confirmed defaults (D-009): subtotal 360 >= ₹200 -> free delivery; COD charge 20 -> Total 380
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.subtotal).toBe(360);
      expect(res.body.data.order.deliveryFee).toBe(0);
      expect(res.body.data.order.codCharge).toBe(20);
      expect(res.body.data.order.total).toBe(380); // 360 + 0 + 20
    });

    it('17. Online payment does not receive COD charge', async () => {
      // Subtotal 360 (free delivery at the ₹200 threshold), COD Charge 0 -> Total 360
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.codCharge).toBe(0);
      expect(res.body.data.order.total).toBe(360);
    });

    it('18. Final order amount is calculated server-side regardless of client input', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
          // Malicious client inputs attempting to override pricing
          total: 1.0,
          deliveryFee: 0.0,
          codCharge: 0.0,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order.total).toBe(380); // Server-calculated 360 + 0 (free delivery) + 20
    });

    it('19. Existing order totals and fees remain immutable when settings change later', async () => {
      // Place order under settings that charge a delivery fee (DeliveryFee: 30, COD Charge: 20)
      await prisma.deliverySettings.updateMany({ data: { freeDeliveryThreshold: 1000 } });
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: customerAddressId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 2 }],
        });

      const orderId = orderRes.body.data.order.id;
      const initialTotal = orderRes.body.data.order.total;
      expect(initialTotal).toBe(410);

      // Now Super Admin changes settings (DeliveryFee -> 100, COD Charge -> 50)
      await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          deliveryFee: 100,
          codCharge: 50,
        });

      // Historical order in database must still reflect original snapshot values
      const storedOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(Number(storedOrder?.deliveryFee)).toBe(30);
      expect(Number(storedOrder?.codCharge)).toBe(20);
      expect(Number(storedOrder?.total)).toBe(410);
    });

    it('20. GET /api/v1/customer/delivery-settings returns current active backend configuration', async () => {
      // Set delivery fee to 50
      await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          deliveryFee: 50,
          freeDeliveryThreshold: 200.0,
          minimumOrderAmount: 199,
          deliveryEnabled: true,
        });

      const res = await request(app).get('/api/v1/customer/delivery-settings');

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.deliveryFee).toBe(50);
      expect(res.body.data.freeDeliveryThreshold).toBe(200);
      expect(res.body.data.deliveryEnabled).toBe(true);
    });

    it('20b. GET /api/v1/customer/delivery-settings returns the COD rules set by the admin', async () => {
      await prisma.deliverySettings.updateMany({
        data: { codEnabled: true, codCharge: 25, minimumCodOrderAmount: 150, maximumCodOrderAmount: 50000 },
      });

      const res = await request(app).get('/api/v1/customer/delivery-settings');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toMatchObject({
        codEnabled: true,
        codCharge: 25,
        minimumCodOrderAmount: 150,
        maximumCodOrderAmount: 50000,
      });
      expect(res.body.data).not.toHaveProperty('pickupCodEnabled');

      await prisma.deliverySettings.updateMany({
        data: { codCharge: 20, minimumCodOrderAmount: 100, maximumCodOrderAmount: 5000 },
      });
    });

    it('21. Cart API returns server-calculated subtotal, deliveryFee, and total from backend settings', async () => {
      // Configure delivery fee = 50
      await request(app)
        .put('/api/v1/admin/settings/fare-cod')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          deliveryFee: 50,
          freeDeliveryThreshold: 200.0,
          minimumOrderAmount: 199,
        });

      // Clear existing cart and add 1 apple (180.00)
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
      await prisma.cartItem.create({
        data: {
          userId: customerId,
          productId: appleProductId,
          quantity: 1,
        },
      });

      const res = await request(app)
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subtotal).toBe(180);
      expect(res.body.data.deliveryFee).toBe(50);
      expect(res.body.data.total).toBe(230); // 180 + 50
    });
  });
});
