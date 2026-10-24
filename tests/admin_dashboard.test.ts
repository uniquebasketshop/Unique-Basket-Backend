import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P2-07: dashboard summary computed server-side, store-isolated.
describe('Admin dashboard summary (P2-07)', () => {
  const phone = '+919888800207';
  let customerId: string;
  let storeA: string;
  let storeB: string;
  let adminToken: string;
  let managerToken: string;
  let seq = 0;

  const createOrder = (storeId: string, orderStatus: any, total: number) => {
    seq += 1;
    return prisma.order.create({
      data: {
        orderNumber: `#UB-P207-${Date.now()}-${seq}`,
        userId: customerId,
        storeId,
        fulfillmentType: 'PICKUP',
        subtotal: total,
        deliveryFee: 0,
        total,
        paymentMethod: 'COD',
        orderStatus,
      },
    });
  };

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    const manager = await prisma.adminUser.findUniqueOrThrow({
      where: { email: 'manager1@uniquebasket.com' },
      include: { managers: true },
    });
    storeA = manager.managers[0].storeId;
    storeB = (await prisma.store.findFirstOrThrow({ where: { id: { not: storeA } } })).id;

    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Dashboard Customer' } });
    customerId = user.id;
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email, storeId: storeA });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  it('matches DB totals for the super admin and isolates managers to their store', async () => {
    const before = await request(app).get('/api/v1/admin/dashboard/summary').set('Authorization', `Bearer ${adminToken}`);
    const managerBefore = await request(app).get('/api/v1/admin/dashboard/summary').set('Authorization', `Bearer ${managerToken}`);
    expect(before.statusCode).toEqual(200);

    await createOrder(storeA, 'DELIVERED', 300);
    await createOrder(storeA, 'PLACED', 100);
    await createOrder(storeB, 'PICKED_UP', 500);
    await createOrder(storeB, 'CANCELLED', 999);

    const after = await request(app).get('/api/v1/admin/dashboard/summary').set('Authorization', `Bearer ${adminToken}`);
    expect(after.body.data.totalOrders - before.body.data.totalOrders).toEqual(4);
    expect(after.body.data.pendingOrders - before.body.data.pendingOrders).toEqual(1);
    expect(after.body.data.revenue - before.body.data.revenue).toEqual(800);
    expect(typeof after.body.data.activeStores).toBe('number');
    expect(after.body.data.recentOrders.length).toBeLessThanOrEqual(5);

    const managerAfter = await request(app).get('/api/v1/admin/dashboard/summary').set('Authorization', `Bearer ${managerToken}`);
    expect(managerAfter.body.data.totalOrders - managerBefore.body.data.totalOrders).toEqual(2);
    expect(managerAfter.body.data.revenue - managerBefore.body.data.revenue).toEqual(300);
    expect(managerAfter.body.data.activeStores).toBeNull();
    for (const o of managerAfter.body.data.recentOrders) {
      expect(o.storeId).toEqual(storeA);
    }
  });

  it('rejects customers', async () => {
    const token = generateAccessToken({ id: customerId, role: 'customer', phone });
    const res = await request(app).get('/api/v1/admin/dashboard/summary').set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toEqual(403);
  });
});
