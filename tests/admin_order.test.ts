import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { FakeCashfree, installFakeCashfree } from './support/fakeCashfree';

describe('Admin Order Operations & Payment Verification Integration Tests', () => {
  // ONLINE orders need a configured gateway; the fake answers Cashfree calls in memory
  let fakeCashfree: FakeCashfree;
  let superAdminToken: string;
  let manager1Token: string;
  let manager2Token: string;
  let customerToken: string;
  let customerId: string;

  let centralStoreId: string;
  let eastStoreId: string;
  let appleProductId: string;

  beforeAll(async () => {
    fakeCashfree = installFakeCashfree();
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

    // 2. Create customer
    const user = await prisma.user.upsert({
      where: { phone: '+919999999999' },
      update: {},
      create: { phone: '+919999999999', name: 'Admin Test Customer' },
    });
    customerId = user.id;

    if (!superAdminUser || !manager1User || !manager2User) {
      throw new Error('Seed admin users not found.');
    }

    // Fetch stores & products
    const centralStore = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const eastStore = await prisma.store.findUnique({ where: { storeId: 'STORE-002' } });
    if (!centralStore || !eastStore) throw new Error('Seeded stores not found.');
    centralStoreId = centralStore.id;
    eastStoreId = eastStore.id;

    const apple = await prisma.product.findFirst({ where: { name: { startsWith: 'Apple' } } });
    if (!apple) throw new Error('Apple product not found.');
    appleProductId = apple.id;

    // Reset stock for Apple
    await prisma.storeInventory.updateMany({
      where: { productId: appleProductId },
      data: { stockQuantity: 50.00, isAvailable: true },
    });

    // 3. Tokens
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

    customerToken = generateAccessToken({
      id: user.id,
      role: 'customer',
      phone: user.phone,
    });
  });

  afterAll(async () => {
    fakeCashfree.restore();
    // Cleanup created orders
    await prisma.orderItem.deleteMany({
      where: { order: { userId: customerId } },
    });
    await prisma.payment.deleteMany({
      where: { order: { userId: customerId } },
    });
    await prisma.order.deleteMany({
      where: { userId: customerId },
    });
    await prisma.auditLog.deleteMany({
      where: { action: { in: ['CREATE_ORDER', 'VERIFY_PICKUP_HANDOVER', 'PAYMENT_VERIFIED_ONLINE'] } },
    });
    await prisma.$disconnect();
  });

  describe('Store Pickup Handover & Verification Isolation', () => {
    let orderNumber: string;

    beforeAll(async () => {
      // Place a PICKUP order for STORE-001 (Central Store)
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });

      orderNumber = res.body.data.order.orderNumber;
    });

    it('should allow Store Manager 1 to verify and handover pickup for their store (STORE-001)', async () => {
      // Handover requires the order to be READY_FOR_PICKUP (P0-04)
      await prisma.order.update({
        where: { orderNumber },
        data: { orderStatus: 'READY_FOR_PICKUP' },
      });

      const res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          orderNumber,
          phone: '+919999999999',
        });

      console.log('[DEBUG] verifyPickup response body:', JSON.stringify(res.body, null, 2));

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('orderStatus', 'PICKED_UP');
      expect(res.body.data).toHaveProperty('paymentStatus', 'PAID');
    });

    it('accepts the registered mobile number as 10 digits for pickup verification (D-008)', async () => {
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });
      expect(orderRes.statusCode).toEqual(201);
      const tenDigitOrder = orderRes.body.data.order.orderNumber;
      await prisma.order.update({ where: { orderNumber: tenDigitOrder }, data: { orderStatus: 'READY_FOR_PICKUP' } });

      const res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({ orderNumber: tenDigitOrder, phone: '99999 99999' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveProperty('orderStatus', 'PICKED_UP');
    });

    it('should reject Store Manager 2 attempting to verify pickup for STORE-001', async () => {
      // Place another PICKUP order for STORE-001
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });

      const secondOrderNo = orderRes.body.data.order.orderNumber;

      const res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set('Authorization', `Bearer ${manager2Token}`)
        .send({
          orderNumber: secondOrderNo,
          phone: '+919999999999',
        });

      // Manager 2 belongs to STORE-002 and cannot verify handovers for STORE-001
      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');
    });

    it('should reject pickup verification for ONLINE orders if payment is PENDING', async () => {
      // Place an ONLINE order for STORE-001
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });

      const onlineOrderNo = orderRes.body.data.order.orderNumber;

      // Try to verify pickup handover - should fail because payment is still PENDING
      const res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({
          orderNumber: onlineOrderNo,
          phone: '+919999999999',
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'ONLINE_PAYMENT_PENDING');
    });
  });

  describe('Online orders with Cashfree (D-020)', () => {
    let onlineOrderId: string;
    let createResponse: request.Response;

    beforeAll(async () => {
      createResponse = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'ONLINE',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });

      expect(createResponse.statusCode).toEqual(201);
      onlineOrderId = createResponse.body.data.order.id;
    });

    it('creates the ONLINE order unpaid, with one pending payment and a checkout session', async () => {
      const order = await prisma.order.findUnique({ where: { id: onlineOrderId }, include: { payments: true } });
      expect(order!.paymentMethod).toBe('ONLINE');
      expect(order!.paymentStatus).toBe('PENDING');
      expect(order!.orderStatus).toBe('PLACED');
      expect(order!.payments).toHaveLength(1);
      expect(order!.payments[0]).toMatchObject({ provider: 'CASHFREE', gatewayOrderId: onlineOrderId, status: 'PENDING' });
      expect(createResponse.body.data.payment).toMatchObject({
        provider: 'CASHFREE',
        environment: 'SANDBOX',
        gatewayOrderId: onlineOrderId,
        paymentSessionId: `session_${onlineOrderId}`,
      });
    });

    it('never returns a signature or secret in admin order details', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/orders/${onlineOrderId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.data.payments[0]).toHaveProperty('gatewayOrderId');
      expect(JSON.stringify(res.body)).not.toMatch(/signature|secret/i);
      expect(JSON.stringify(res.body)).not.toContain(process.env.CASHFREE_CLIENT_SECRET!);
    });

    it('refuses ONLINE orders when no payment gateway is configured', async () => {
      const savedId = process.env.CASHFREE_CLIENT_ID;
      delete process.env.CASHFREE_CLIENT_ID;
      try {
        const res = await request(app)
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({ fulfillmentType: 'PICKUP', storeId: centralStoreId, paymentMethod: 'ONLINE', items: [{ productId: appleProductId, quantity: 1.0 }] });
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toEqual('ONLINE_PAYMENT_UNAVAILABLE');
      } finally {
        process.env.CASHFREE_CLIENT_ID = savedId;
      }
    });
  });

  describe('Store Manager Read Security Isolation Checks', () => {
    let secondOrderNo: string;
    let store2OrderId: string;

    beforeAll(async () => {
      // Create an order for STORE-002 (East Store) in database directly to test manager isolation
      const order2 = await prisma.order.create({
        data: {
          orderNumber: `UB-TEST-SM2-${Date.now()}`,
          userId: customerId,
          storeId: eastStoreId,
          fulfillmentType: 'PICKUP',
          paymentMethod: 'COD',
          subtotal: 250.0,
          deliveryFee: 0.0,
          total: 250.0,
          orderStatus: 'PLACED',
          items: {
            create: [
              {
                productId: appleProductId,
                quantity: 1.0,
                unitPrice: 250.0,
                totalPrice: 250.0,
              },
            ],
          },
        },
      });

      secondOrderNo = order2.orderNumber;
      store2OrderId = order2.id;
    });

    it('should reject Store Manager 1 attempting to view order details for STORE-002', async () => {
      // Staff read orders through the admin API (the customer route is customer-only, A-08)
      const res = await request(app)
        .get(`/api/v1/admin/orders/${store2OrderId}`)
        .set('Authorization', `Bearer ${manager1Token}`);

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');

      const customerRoute = await request(app)
        .get(`/api/v1/orders/${store2OrderId}`)
        .set('Authorization', `Bearer ${manager1Token}`);
      expect(customerRoute.statusCode).toEqual(403);
      expect(customerRoute.body).toHaveProperty('errorCode', 'FORBIDDEN_ACCESS');
    });

    it('should reject Store Manager 1 attempting to read inventory list for STORE-002', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${eastStoreId}`)
        .set('Authorization', `Bearer ${manager1Token}`);

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');
    });

    it('should reject customer attempting to read inventory list for inactive STORE-002', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${eastStoreId}`)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.statusCode).toEqual(404);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'STORE_NOT_FOUND');
    });

    it('should allow Store Manager 2 or Super Admin to read inventory list for STORE-002', async () => {
      const res = await request(app)
        .get(`/api/v1/products/store/${eastStoreId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
    });
  });

  describe('Super Admin COD Toggle & Checkout Validation', () => {
    afterAll(async () => {
      // Restore COD to true for further checkouts
      await prisma.deliverySettings.updateMany({
        data: { codEnabled: true },
      });
    });

    it('should allow Super Admin to disable COD', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ codEnabled: false });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('codEnabled', false);
    });

    it('should reject Cash on Delivery order creation when COD is disabled', async () => {
      // The COD switch applies to delivery only; Pay at Store for pickup is always available (D-018).
      const address = await prisma.userAddress.create({
        data: {
          userId: customerId,
          title: 'Home',
          addressLine: 'Nana Mava Road',
          city: 'Rajkot',
          state: 'Gujarat',
          pincode: '360005',
          latitude: 22.308,
          longitude: 70.8,
        },
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'DELIVERY',
          addressId: address.id,
          paymentMethod: 'COD',
          // 2 x ₹180 = ₹360: above the ₹199 delivery minimum, so only the COD switch can reject it.
          items: [{ productId: appleProductId, quantity: 2.0 }],
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'COD_DISABLED');
    });

    it('should allow Super Admin to enable COD back', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ codEnabled: true });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('codEnabled', true);
    });
  });

  describe('Admin Order List, Search, Filters, State Transitions & Cancellation', () => {
    let testOrderId: string;

    beforeAll(async () => {
      // Place a PLACED order for testing transitions
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId: centralStoreId,
          paymentMethod: 'COD',
          items: [{ productId: appleProductId, quantity: 1.0 }],
        });

      testOrderId = res.body.data.order.id;
    });

    it('should allow Super Admin to query paginated orders list', async () => {
      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ page: 1, limit: 5 });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('orders');
      expect(res.body.data).toHaveProperty('pagination');
      expect(res.body.data.pagination.page).toEqual(1);
    });

    it('should filter by paymentStatus=REFUNDED (refunds exist since D-022) and reject unknown statuses', async () => {
      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ paymentStatus: 'REFUNDED' });

      expect(res.statusCode).toEqual(200);
      expect((res.body.data as Array<{ paymentStatus: string }>).every((o) => o.paymentStatus === 'REFUNDED')).toBe(true);

      const bad = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .query({ paymentStatus: 'REVERSED' });
      expect(bad.statusCode).toEqual(400);
      expect(bad.body).toHaveProperty('errorCode', 'INVALID_PAYMENT_STATUS');
    });

    it('should allow Store Manager 1 to retrieve only assigned store orders', async () => {
      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${manager1Token}`);

      expect(res.statusCode).toEqual(200);
      const orders = res.body.data.orders || res.body.data;
      const invalidStores = orders.filter((o: any) => o.storeId !== centralStoreId);
      expect(invalidStores.length).toEqual(0);
    });

    it('should fetch complete order details with items and address', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/orders/${testOrderId}`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveProperty('id', testOrderId);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data).toHaveProperty('store');
    });

    it('should reject invalid order status transition (e.g. PLACED -> DELIVERED)', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/orders/${testOrderId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'DELIVERED' });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_TRANSITION');
    });

    it('should allow valid transition (PLACED -> CONFIRMED)', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/orders/${testOrderId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CONFIRMED' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CONFIRMED');
    });

    it('should allow cancellation and restore inventory stock', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/orders/${testOrderId}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CANCELLED');

      // Verify inventory transaction created
      const invTx = await prisma.inventoryTransaction.findFirst({
        where: { type: 'ORDER_CANCELLATION_RESTORE', productId: appleProductId },
        orderBy: { createdAt: 'desc' },
      });
      expect(invTx).toBeDefined();
    });

    // CURRENT BEHAVIOUR, NOT A DECISION (P1-16): refund handling is undecided (P4-09).
    // Update this test when the cancellation/refund policy is confirmed.
    it('cancels a paid online order that has no gateway payment record without starting a refund', async () => {
      // (Orders paid through Cashfree are refunded automatically: tests/cashfree_payments.test.ts)
      const order = await prisma.order.create({
        data: {
          orderNumber: `TST-CANCEL-PAID-${Date.now().toString().slice(-8)}`,
          userId: customerId,
          storeId: centralStoreId,
          fulfillmentType: 'PICKUP',
          paymentMethod: 'ONLINE',
          paymentStatus: 'PAID',
          orderStatus: 'CONFIRMED',
          subtotal: 90,
          deliveryFee: 0,
          discount: 0,
          total: 90,
        },
      });

      const res = await request(app)
        .put(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CANCELLED');
      expect(res.body.data.paymentStatus).toEqual('PAID');

      const refundLogs = await prisma.auditLog.findMany({
        where: {
          action: { in: ['REFUND_STARTED', 'REFUND_COMPLETED', 'REFUND_FAILED'] },
          details: { contains: order.orderNumber },
        },
      });
      expect(refundLogs).toHaveLength(0);
      expect(await prisma.refund.count({ where: { orderId: order.id } })).toEqual(0);
    });

    it('should complete full DELIVERY status workflow (D-013): PLACED -> CONFIRMED -> OUT_FOR_DELIVERY -> DELIVERED', async () => {
      const delivOrder = await prisma.order.create({
        data: {
          orderNumber: `TST-DELIV-${Date.now().toString().slice(-8)}`,
          userId: customerId,
          storeId: centralStoreId,
          fulfillmentType: 'DELIVERY',
          paymentMethod: 'COD',
          paymentStatus: 'PENDING',
          orderStatus: 'PLACED',
          subtotal: 200,
          deliveryFee: 30,
          discount: 0,
          total: 230,
        },
      });

      // 1. PLACED -> CONFIRMED
      let res = await request(app)
        .put(`/api/v1/admin/orders/${delivOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CONFIRMED' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CONFIRMED');

      // 2. PREPARING is no longer part of the lifecycle
      res = await request(app)
        .put(`/api/v1/admin/orders/${delivOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'PREPARING' });
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_TRANSITION');

      // 3. READY_FOR_PICKUP is pickup-only
      res = await request(app)
        .put(`/api/v1/admin/orders/${delivOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'READY_FOR_PICKUP' });
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_STATUS_FOR_FULFILLMENT');

      // 4. CONFIRMED -> OUT_FOR_DELIVERY
      res = await request(app)
        .put(`/api/v1/admin/orders/${delivOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'OUT_FOR_DELIVERY' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('OUT_FOR_DELIVERY');

      // 5. OUT_FOR_DELIVERY -> DELIVERED
      res = await request(app)
        .put(`/api/v1/admin/orders/${delivOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'DELIVERED' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('DELIVERED');
      expect(res.body.data.paymentStatus).toEqual('PAID');
    });

    it('should complete full PICKUP status workflow (D-013): PLACED -> CONFIRMED -> READY_FOR_PICKUP -> PICKED_UP (via pickup verification)', async () => {
      const pickOrder = await prisma.order.create({
        data: {
          orderNumber: `TST-PICK-${Date.now().toString().slice(-8)}`,
          userId: customerId,
          storeId: centralStoreId,
          fulfillmentType: 'PICKUP',
          paymentMethod: 'COD',
          paymentStatus: 'PENDING',
          orderStatus: 'PLACED',
          subtotal: 150,
          deliveryFee: 0,
          discount: 0,
          total: 150,
        },
      });

      // 1. PLACED -> CONFIRMED
      let res = await request(app)
        .put(`/api/v1/admin/orders/${pickOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'CONFIRMED' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('CONFIRMED');

      // 3. CONFIRMED -> READY_FOR_PICKUP
      res = await request(app)
        .put(`/api/v1/admin/orders/${pickOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'READY_FOR_PICKUP' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('READY_FOR_PICKUP');

      // 4. READY_FOR_PICKUP -> PICKED_UP is not allowed via the generic status endpoint (P0-05 / D-006)
      res = await request(app)
        .put(`/api/v1/admin/orders/${pickOrder.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'PICKED_UP' });
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'PICKUP_VERIFICATION_REQUIRED');

      // 5. Pickup is completed through pickup verification (order number + registered phone)
      res = await request(app)
        .post('/api/v1/admin/orders/pickup-verify')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ orderNumber: pickOrder.orderNumber, phone: '+919999999999' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.orderStatus).toEqual('PICKED_UP');
      expect(res.body.data.paymentStatus).toEqual('PAID');
    });
  });
});
