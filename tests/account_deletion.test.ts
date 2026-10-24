import request from 'supertest';
import { randomUUID } from 'crypto';
import { OrderStatus } from '@prisma/client';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { issueRefreshToken } from '../src/services/sessionService';
import { deletedPhoneFor } from '../src/utils/deletedAccount';

// Customer deletes their own account (App Store / Play requirement): orders kept, personal data removed.
describe('Customer account deletion', () => {
  // Each customer gets its own phone so earlier customers (with orders) never block a new one.
  let phoneSeq = 0;
  const nextPhone = () => `+9198888007${String(phoneSeq++).padStart(2, '0')}`;
  let storeId: string;
  let productId: string;
  let adminToken: string;
  const userIds: string[] = [];
  let seq = 0;

  const deleteAccount = (token: string) =>
    request(app).delete('/api/v1/customer/account').set('Authorization', `Bearer ${token}`);

  async function makeCustomer() {
    const phone = nextPhone();
    await prisma.user.deleteMany({ where: { phone } });
    const user = await prisma.user.create({
      data: { phone, name: 'Asha Delete', email: 'asha@example.com', gender: 'Female', avatarId: 'mango', dob: new Date('1990-01-01') },
    });
    userIds.push(user.id);
    return { user, phone, token: generateAccessToken({ id: user.id, role: 'customer', phone }) };
  }

  async function makeOrder(userId: string, orderStatus: OrderStatus, extra: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-DEL${String(Date.now()).slice(-6)}-${seq}`,
        userId,
        storeId,
        fulfillmentType: 'DELIVERY',
        subtotal: 250,
        deliveryFee: 0,
        total: 250,
        paymentMethod: 'COD',
        orderStatus,
        idempotencyKey: randomUUID(),
        deliveryAddressSnapshot: {
          id: randomUUID(),
          title: 'Home',
          addressLine: '12 Private Street, Near Temple',
          city: 'Rajkot',
          state: 'Gujarat',
          pincode: '360005',
          latitude: 22.27,
          longitude: 70.75,
          locationConfirmed: true,
        },
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } });
    storeId = store.id;
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
    const product = await prisma.product.create({ data: { name: 'DEL Guava', categoryId: category.id, unit: 'KG', price: 100 } });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.refund.deleteMany({ where: { order: { userId: { in: userIds } } } });
    await prisma.payment.deleteMany({ where: { order: { userId: { in: userIds } } } });
    await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.cartItem.deleteMany({ where: { productId } });
    await prisma.favorite.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.auditLog.deleteMany({ where: { action: 'CUSTOMER_ACCOUNT_DELETED', details: { contains: 'deleted their account' } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('requires a logged-in customer', async () => {
    expect((await request(app).delete('/api/v1/customer/account')).statusCode).toBe(401);
    expect((await deleteAccount(adminToken)).statusCode).toBe(403);
  });

  it('removes personal data, keeps orders, ends sessions and frees the phone for a new account', async () => {
    const { user, phone, token } = await makeCustomer();
    await prisma.userAddress.create({
      data: { userId: user.id, title: 'Home', addressLine: '12 Private Street', city: 'Rajkot', state: 'Gujarat', pincode: '360005', latitude: 22.27, longitude: 70.75 },
    });
    await prisma.cartItem.create({ data: { userId: user.id, productId, quantity: 1 } });
    await prisma.favorite.create({ data: { userId: user.id, productId } });
    await prisma.notification.create({ data: { userId: user.id, title: 'Hi', body: 'Hello' } });
    await prisma.deviceToken.create({ data: { userId: user.id, token: `del-test-${randomUUID()}`, platform: 'ANDROID' } });
    const refreshToken = await issueRefreshToken({ id: user.id, role: 'customer' });
    const delivered = await makeOrder(user.id, OrderStatus.DELIVERED);
    const cancelled = await makeOrder(user.id, OrderStatus.CANCELLED);

    const res = await deleteAccount(token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Your account has been deleted.' });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({
      phone: deletedPhoneFor(user.id),
      name: null,
      email: null,
      dob: null,
      gender: null,
      avatarId: null,
      isActive: false,
    });
    for (const count of await Promise.all([
      prisma.userAddress.count({ where: { userId: user.id } }),
      prisma.cartItem.count({ where: { userId: user.id } }),
      prisma.favorite.count({ where: { userId: user.id } }),
      prisma.notification.count({ where: { userId: user.id } }),
      prisma.deviceToken.count({ where: { userId: user.id } }),
      prisma.refreshToken.count({ where: { userId: user.id } }),
    ])) {
      expect(count).toBe(0);
    }

    // Orders stay (store accounts) with only city/state/pincode left of the address.
    const orders = await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(orders.map((o) => o.id).sort()).toEqual([delivered.id, cancelled.id].sort());
    for (const order of orders) {
      expect(order.deliveryAddressSnapshot).toEqual({ city: 'Rajkot', state: 'Gujarat', pincode: '360005' });
      expect(order.idempotencyKey).toBeNull();
      expect(Number(order.total)).toBe(250);
    }

    // Old tokens stop working immediately.
    expect((await request(app).get('/api/v1/customer/profile').set('Authorization', `Bearer ${token}`)).statusCode).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).statusCode).toBe(401);
    expect((await deleteAccount(token)).statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'CUSTOMER_ACCOUNT_DELETED', details: { contains: user.id } } });
    expect(audit?.details).not.toContain(phone);

    // The same phone can sign up again as a brand-new account.
    const otp = await request(app).post('/api/v1/auth/send-otp').send({ phone });
    expect(otp.statusCode).toBe(200);
    const login = await request(app).post('/api/v1/auth/verify-otp').send({ phone, otp: '1234' });
    expect(login.statusCode).toBe(200);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { phone } });
    userIds.push(fresh.id);
    expect(fresh.id).not.toBe(user.id);
    expect(fresh.name).toBeNull();
    expect(await prisma.order.count({ where: { userId: fresh.id } })).toBe(0);
  });

  it.each([OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.READY_FOR_PICKUP])(
    'is refused while an order is %s, and nothing is removed',
    async (status) => {
      const { user, phone, token } = await makeCustomer();
      await makeOrder(user.id, status);

      const res = await deleteAccount(token);
      expect(res.statusCode).toBe(409);
      expect(res.body.errorCode).toBe('ACCOUNT_HAS_ACTIVE_ORDERS');
      expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ phone, name: 'Asha Delete', isActive: true });
    },
  );

  it('is refused while a refund is still owed', async () => {
    const { user, token } = await makeCustomer();
    const order = await makeOrder(user.id, OrderStatus.CANCELLED, { paymentMethod: 'ONLINE', paymentStatus: 'PAID' });
    const payment = await prisma.payment.create({
      data: { orderId: order.id, gatewayOrderId: `del_${order.id}`, amount: 250, status: 'PAID' },
    });
    const refund = await prisma.refund.create({ data: { orderId: order.id, paymentId: payment.id, amount: 250, status: 'FAILED' } });

    const res = await deleteAccount(token);
    expect(res.statusCode).toBe(409);
    expect(res.body.errorCode).toBe('ACCOUNT_HAS_PENDING_REFUND');

    // Once the refund completes, deletion goes through.
    await prisma.refund.update({ where: { id: refund.id }, data: { status: 'SUCCESS' } });
    expect((await deleteAccount(token)).statusCode).toBe(200);
  });

  it('admin sees the account as deleted and cannot reactivate it', async () => {
    const { user, token } = await makeCustomer();
    expect((await deleteAccount(token)).statusCode).toBe(200);

    const details = await request(app).get(`/api/v1/admin/customers/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(details.statusCode).toBe(200);
    expect(details.body.data.customer).toMatchObject({ name: 'Deleted customer', isActive: false, isDeleted: true, email: null });
    expect(details.body.data.addresses).toEqual([]);

    const list = await request(app)
      .get('/api/v1/admin/customers')
      .query({ search: user.id })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.customers[0]).toMatchObject({ id: user.id, isDeleted: true, name: 'Deleted customer' });

    const reactivate = await request(app)
      .put(`/api/v1/admin/customers/${user.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: true });
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.body.errorCode).toBe('ACCOUNT_DELETED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(false);
  });

  it('a normal customer shows isDeleted false to admin', async () => {
    const { user, phone } = await makeCustomer();
    const details = await request(app).get(`/api/v1/admin/customers/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(details.body.data.customer).toMatchObject({ phone, isDeleted: false, name: 'Asha Delete' });
  });
});
