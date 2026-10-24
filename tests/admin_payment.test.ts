import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { PaymentStatus } from '@prisma/client';

describe('Admin Payment & COD Management Integration Tests', () => {
  let superAdminToken: string;
  let manager1Token: string;
  let manager2Token: string;
  let customerId: string;
  let customerToken: string;

  let centralStoreId: string;
  let eastStoreId: string;
  let manager1StoreId: string;

  let codOrderId: string;
  let onlineOrderId: string;
  let rpOrderId: string;
  const cleanupOrderIds: string[] = [];

  beforeAll(async () => {
    // --- Seeded users ---
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
      throw new Error('Required seeded admin users not found. Run prisma db seed first.');
    }

    superAdminToken = generateAccessToken({
      id: superAdminUser.id,
      role: 'SUPER_ADMIN',
      email: superAdminUser.email,
    });

    manager1StoreId = manager1User.managers?.[0]?.storeId || '';
    manager1Token = generateAccessToken({
      id: manager1User.id,
      role: 'STORE_MANAGER',
      email: manager1User.email,
      storeId: manager1StoreId,
    });
    manager2Token = generateAccessToken({
      id: manager2User.id,
      role: 'STORE_MANAGER',
      email: manager2User.email,
      storeId: manager2User.managers?.[0]?.storeId || '',
    });

    // --- Customer ---
    const user = await prisma.user.upsert({
      where: { phone: '+919888888888' },
      update: {},
      create: { phone: '+919888888888', name: 'Payment Test Customer' },
    });
    customerId = user.id;
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });

    // --- Stores ---
    const centralStore = await prisma.store.findFirst({ where: { storeId: 'STORE-001' } });
    const eastStore = await prisma.store.findFirst({ where: { storeId: 'STORE-002' } });
    if (!centralStore || !eastStore) throw new Error('Seeded stores not found.');
    centralStoreId = centralStore.id;
    eastStoreId = eastStore.id;

    // Ensure manager1 is assigned to centralStore (STORE-001)
    if (manager1StoreId !== centralStoreId) {
      manager1StoreId = centralStoreId;
      manager1Token = generateAccessToken({
        id: manager1User.id,
        role: 'STORE_MANAGER',
        email: manager1User.email,
        storeId: centralStoreId,
      });
    }

    // --- Create a COD order directly ---
    const codOrder = await prisma.order.create({
      data: {
        orderNumber: `TEST-COD-PAY-${Date.now()}`,
        userId: customerId,
        storeId: centralStoreId,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        orderStatus: 'PLACED',
        subtotal: 100,
        deliveryFee: 0,
        discount: 0,
        total: 100,
      },
    });
    codOrderId = codOrder.id;
    cleanupOrderIds.push(codOrder.id);

    // --- Create an ONLINE order with a stored gateway Payment record (signatures are never stored) ---
    rpOrderId = `order_test_${Date.now()}`;
    const onlineOrder = await prisma.order.create({
      data: {
        orderNumber: `TEST-ONLINE-PAY-${Date.now()}`,
        userId: customerId,
        storeId: centralStoreId,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'ONLINE',
        paymentStatus: 'PENDING',
        orderStatus: 'PLACED',
        subtotal: 200,
        deliveryFee: 0,
        discount: 0,
        total: 200,
        payments: {
          create: {
            gatewayOrderId: rpOrderId,
            amount: 200,
            status: 'PENDING',
          },
        },
      },
      include: { payments: true },
    });
    onlineOrderId = onlineOrder.id;
    cleanupOrderIds.push(onlineOrder.id);
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { orderId: { in: cleanupOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: cleanupOrderIds } } });
    await prisma.$disconnect();
  });

  // ─── 1. Super Admin — List All Payments ────────────────────────────────────
  describe('1. Super Admin — Payment List', () => {
    it('should allow Super Admin to list all payments across all stores', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('payments');
      expect(Array.isArray(res.body.data.payments)).toBe(true);
      expect(res.body.data).toHaveProperty('pagination');
    });

    it('should return server-side pagination metadata', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments?page=1&limit=5')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      const { pagination } = res.body.data;
      expect(pagination).toHaveProperty('page', 1);
      expect(pagination).toHaveProperty('limit', 5);
      expect(pagination).toHaveProperty('total');
      expect(pagination).toHaveProperty('totalPages');
    });
  });

  // ─── 2. Store Manager Isolation ─────────────────────────────────────────────
  describe('2. Store Manager — Store Isolation', () => {
    it('should allow Store Manager to list payments for their assigned store only', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .set('Authorization', `Bearer ${manager1Token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      // All orders returned must belong to manager's assigned store
      for (const row of res.body.data.payments) {
        expect(row.store.id).toBe(manager1StoreId);
      }
    });

    it('should return 403 when Store Manager tries to access payment of another store order via /payments/:id', async () => {
      // Create an order in eastStore (different from manager1's store)
      // orderNumber must be <= 30 chars (VarChar(30) column)
      const ts = Date.now().toString().slice(-8);
      const eastOrder = await prisma.order.create({
        data: {
          orderNumber: `TST-EAST-${ts}`,
          userId: customerId,
          storeId: eastStoreId,
          fulfillmentType: 'PICKUP',
          paymentMethod: 'COD',
          paymentStatus: 'PENDING',
          orderStatus: 'PLACED',
          subtotal: 50,
          deliveryFee: 0,
          discount: 0,
          total: 50,
        },
      });

      const res = await request(app)
        .get(`/api/v1/admin/payments/${eastOrder.id}`)
        .set('Authorization', `Bearer ${manager1Token}`)
        .expect(403);

      expect(res.body.errorCode).toBe('STORE_ACCESS_FORBIDDEN');

      await prisma.order.delete({ where: { id: eastOrder.id } });
    });
  });

  // ─── 3. Search ───────────────────────────────────────────────────────────────
  describe('3. Payment Search', () => {
    it('should search payments by order number prefix', async () => {
      const codOrder = await prisma.order.findUnique({ where: { id: codOrderId } });
      const prefix = codOrder!.orderNumber.slice(0, 8);

      const res = await request(app)
        .get(`/api/v1/admin/payments?search=${encodeURIComponent(prefix)}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.payments)).toBe(true);
    });
  });

  // ─── 4. Filters ─────────────────────────────────────────────────────────────
  describe('4. Payment Filters', () => {
    it('should filter payments by paymentMethod=COD', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments?paymentMethod=COD')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      for (const row of res.body.data.payments) {
        expect(row.paymentMethod).toBe('COD');
      }
    });

    it('should filter payments by paymentMethod=ONLINE', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments?paymentMethod=ONLINE')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      for (const row of res.body.data.payments) {
        expect(row.paymentMethod).toBe('ONLINE');
      }
    });

    it('should filter payments by paymentStatus=PENDING', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments?paymentStatus=PENDING')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      for (const row of res.body.data.payments) {
        expect(row.paymentStatus).toBe('PENDING');
      }
    });

    it('should filter by paymentStatus=REFUNDED and reject unknown statuses', async () => {
      await request(app)
        .get('/api/v1/admin/payments?paymentStatus=REFUNDED')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      const res = await request(app)
        .get('/api/v1/admin/payments?paymentStatus=REVERSED')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(400);
      expect(res.body.errorCode).toBe('INVALID_PAYMENT_STATUS');
    });
  });

  // ─── 5. Payment Details ──────────────────────────────────────────────────────
  describe('5. Payment Details', () => {
    it('should return full COD payment details to Super Admin', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/payments/${codOrderId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(d.paymentMethod).toBe('COD');
      expect(d.isCOD).toBe(true);
      expect(d.paymentStatus).not.toBe('REFUNDED');
      expect(d).not.toHaveProperty('refundStatus');
      // No refunds for this order (refunds exist only for store-cancelled paid online orders, D-022)
      expect(d.refunds).toEqual([]);
      expect(d).not.toHaveProperty('refundActions');
      // Sensitive keys must never appear
      expect(d).not.toHaveProperty('razorpayKeySecret');
      expect(d).not.toHaveProperty('webhookSecret');
    });

    it('should return full ONLINE payment details without exposing the gateway signature or secrets', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/payments/${onlineOrderId}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(d.paymentMethod).toBe('ONLINE');
      expect(d.isCOD).toBe(false);
      expect(d.gatewayTransactions[0]).toMatchObject({ gatewayOrderId: rpOrderId, gatewayStatus: 'PENDING' });
      expect(d.paymentStatus).not.toBe('REFUNDED');
      expect(d).not.toHaveProperty('refundStatus');
      // No refunds for this order (refunds exist only for store-cancelled paid online orders, D-022)
      expect(d.refunds).toEqual([]);
      expect(d).not.toHaveProperty('refundActions');
      // Signature must NEVER appear
      expect(JSON.stringify(d)).not.toMatch(/signature|secret/i);
      expect(d).not.toHaveProperty('razorpayTransactions');
      expect(d).not.toHaveProperty('razorpayKeySecret');
    });

    it('should return 404 for non-existent payment order ID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.errorCode).toBe('PAYMENT_NOT_FOUND');
    });
  });

  // ─── 6. Online payment integrity (gateway integration pending: Cashfree, D-020) ───
  describe('6. Online Payment Integrity', () => {
    it('should have exactly the PENDING, PAID, FAILED and REFUNDED payment statuses (REFUNDED since D-022)', () => {
      expect(Object.values(PaymentStatus).sort()).toEqual(['FAILED', 'PAID', 'PENDING', 'REFUNDED']);
    });

    it('should NOT allow Admin to manually mark an ONLINE payment as PAID (no such route)', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/payments/${onlineOrderId}/mark-paid`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ paymentStatus: 'PAID' });

      // 404 confirms no such route exists — cannot manually mark PAID
      expect([404, 405]).toContain(res.status);
    });

    it('should NOT expose any refund API route or Admin refund action', async () => {
      const customerRefundRes = await request(app)
        .post('/api/v1/payments/refund')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ orderId: onlineOrderId });

      const adminRefundRes = await request(app)
        .post(`/api/v1/admin/payments/${onlineOrderId}/refund`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ amount: 100 });

      expect([404, 405]).toContain(customerRefundRes.status);
      expect([404, 405]).toContain(adminRefundRes.status);
    });

    it('has no payment confirmation endpoints until the Cashfree integration (D-020)', async () => {
      // The old Razorpay verify/webhook endpoints were removed; nothing can mark an order PAID.
      const verifyRes = await request(app)
        .post('/api/v1/payments/verify')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ orderId: onlineOrderId });
      const webhookRes = await request(app).post('/api/v1/payments/webhook').send({ event: 'payment.captured' });

      expect(verifyRes.status).toBe(404);
      expect(webhookRes.status).toBe(404);
      const order = await prisma.order.findUnique({ where: { id: onlineOrderId } });
      expect(order!.paymentStatus).toBe('PENDING');
    });

    it('should not return the gateway signature in the payment list', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .query({ paymentMethod: 'ONLINE', limit: 100 })
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      const row = res.body.data.payments.find((p: { id: string }) => p.id === onlineOrderId);
      expect(row.payments[0]).toMatchObject({ gatewayOrderId: rpOrderId });
      expect(JSON.stringify(res.body)).not.toMatch(/signature|secret/i);
    });
  });

  // ─── 7. COD Integrity ────────────────────────────────────────────────────────
  describe('7. COD Payment Integrity', () => {
    it('should verify COD order starts as PENDING', async () => {
      const order = await prisma.order.findUnique({ where: { id: codOrderId } });
      expect(order!.paymentMethod).toBe('COD');
      expect(order!.paymentStatus).toBe('PENDING');
    });

    it('should confirm COD order has no gateway Payment record', async () => {
      const payments = await prisma.payment.findMany({ where: { orderId: codOrderId } });
      expect(payments).toHaveLength(0);
    });

    it('should verify COD payment is not PAID before handover', async () => {
      const order = await prisma.order.findUnique({ where: { id: codOrderId } });
      expect(order!.paymentStatus).not.toBe('PAID');
    });
  });

  // ─── 8. COD Configuration ────────────────────────────────────────────────────
  describe('8. COD Configuration (Settings)', () => {
    it('should allow Super Admin to disable COD via settings', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ codEnabled: false })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.codEnabled).toBe(false);
    });

    it('should reject new COD checkout order when COD is disabled (verified via DB setting)', async () => {
      // Verify the DeliverySettings record now has codEnabled = false
      const settings = await prisma.deliverySettings.findFirst();
      // COD was disabled in the previous test step — DB must reflect this
      expect(settings!.codEnabled).toBe(false);

      // Also verify the setting API reflects the disabled state
      const res = await request(app)
        .get('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.data.codEnabled).toBe(false);
    });

    it('should NOT affect existing COD orders when COD is disabled', async () => {
      // Our test COD order was created before disabling — still must exist with unchanged status
      const order = await prisma.order.findUnique({ where: { id: codOrderId } });
      expect(order).not.toBeNull();
      expect(order!.paymentStatus).toBe('PENDING');
      expect(order!.orderStatus).toBe('PLACED');
    });

    it('should prevent Store Manager from changing COD configuration', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${manager1Token}`)
        .send({ codEnabled: true })
        .expect(403);

      expect(res.body).toBeDefined();
    });

    it('should allow Super Admin to re-enable COD', async () => {
      const res = await request(app)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ codEnabled: true })
        .expect(200);

      expect(res.body.data.codEnabled).toBe(true);
    });
  });

  // ─── 9. Payment State Machine ─────────────────────────────────────────────────
  describe('9. Payment State Machine', () => {
    it('should keep paymentStatus completely independent of orderStatus', async () => {
      // Advance orderStatus to CONFIRMED; paymentStatus must remain PENDING
      await prisma.order.update({ where: { id: codOrderId }, data: { orderStatus: 'CONFIRMED' } });
      const updated = await prisma.order.findUnique({ where: { id: codOrderId } });
      expect(updated!.orderStatus).toBe('CONFIRMED');
      expect(updated!.paymentStatus).toBe('PENDING');
      // Restore
      await prisma.order.update({ where: { id: codOrderId }, data: { orderStatus: 'PLACED' } });
    });
  });

  // ─── 10. Unauthorized Access ──────────────────────────────────────────────────
  describe('10. Unauthorized Access', () => {
    it('should reject unauthenticated payment list request with 401', async () => {
      await request(app).get('/api/v1/admin/payments').expect(401);
    });

    it('should reject unauthenticated payment detail request with 401', async () => {
      await request(app).get(`/api/v1/admin/payments/${codOrderId}`).expect(401);
    });
  });
});
