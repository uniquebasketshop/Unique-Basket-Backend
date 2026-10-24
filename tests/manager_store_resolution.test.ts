import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P1-10: store isolation uses the manager's current DB assignment, not the token claim.
describe('Store manager store resolution (P1-10)', () => {
  let managerId: string;
  let storeAId: string;
  let storeBId: string;

  const listOrders = (token: string) =>
    request(app).get('/api/v1/admin/orders').set('Authorization', `Bearer ${token}`);

  const listInventory = (token: string, storeId: string) =>
    request(app).get(`/api/v1/products/store/${storeId}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const storeA = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const storeB = await prisma.store.findUnique({ where: { storeId: 'STORE-002' } });
    if (!storeA || !storeB) throw new Error('Seeded stores not found.');
    storeAId = storeA.id;
    storeBId = storeB.id;

    const manager = await prisma.adminUser.create({
      data: {
        email: `p110-manager-${Date.now()}@test.local`,
        passwordHash: await bcrypt.hash('unused-password', 4),
        name: 'P110 Manager',
        role: 'STORE_MANAGER',
        managers: { create: { storeId: storeAId } },
      },
    });
    managerId = manager.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: managerId } });
    await prisma.$disconnect();
  });

  it('denies the old store immediately after the manager is reassigned, even with an old token', async () => {
    // Token minted while assigned to store A
    const token = generateAccessToken({ id: managerId, role: 'STORE_MANAGER', storeId: storeAId });
    expect((await listInventory(token, storeAId)).statusCode).toEqual(200);

    // Reassign to store B
    await prisma.storeManager.deleteMany({ where: { adminUserId: managerId } });
    await prisma.storeManager.create({ data: { adminUserId: managerId, storeId: storeBId } });

    const oldStore = await listInventory(token, storeAId);
    expect(oldStore.statusCode).toEqual(403);
    expect(oldStore.body).toHaveProperty('errorCode', 'STORE_ACCESS_FORBIDDEN');
    expect((await listInventory(token, storeBId)).statusCode).toEqual(200);
  });

  it('only returns orders of the current store', async () => {
    const token = generateAccessToken({ id: managerId, role: 'STORE_MANAGER', storeId: storeAId });
    const res = await listOrders(token);
    expect(res.statusCode).toEqual(200);
    const storeIds = new Set((res.body.data as any[]).map((o) => o.storeId));
    expect(storeIds.has(storeAId)).toBe(false);
  });

  it('rejects a manager with no store assignment instead of returning all stores', async () => {
    await prisma.storeManager.deleteMany({ where: { adminUserId: managerId } });
    const token = generateAccessToken({ id: managerId, role: 'STORE_MANAGER', storeId: storeAId });

    const res = await listOrders(token);
    expect(res.statusCode).toEqual(403);
    expect(res.body).toHaveProperty('errorCode', 'NO_STORE_ASSIGNMENT');
  });

  it('applies a role change immediately (token claims SUPER_ADMIN, DB says STORE_MANAGER)', async () => {
    await prisma.storeManager.create({ data: { adminUserId: managerId, storeId: storeBId } });
    const forgedRoleToken = generateAccessToken({ id: managerId, role: 'SUPER_ADMIN' });

    const res = await request(app).get('/api/v1/admin/customers').set('Authorization', `Bearer ${forgedRoleToken}`);
    expect(res.statusCode).toEqual(403);
  });
});
