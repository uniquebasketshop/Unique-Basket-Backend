import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/db';
import { AppError } from '../src/utils/errors';
import { createManager, getManager, listManagers, updateManager } from '../src/services/managerService';

// P2-01: store manager rules live in services/managerService.
describe('managerService (P2-01)', () => {
  const email = 'p201.manager@uniquebasket.com';
  let actorId: string;
  let storeA: { id: string; storeId: string };
  let storeB: { id: string };
  let managerId: string;

  beforeAll(async () => {
    actorId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } })).id;
    const stores = await prisma.store.findMany({ orderBy: { storeId: 'asc' }, take: 2 });
    [storeA, storeB] = stores;
    // Re-runnable on the same database: start without audit rows from earlier runs.
    await prisma.auditLog.deleteMany({ where: { details: { contains: 'P201 Manager' } } });
  });

  afterAll(async () => {
    const m = await prisma.adminUser.findUnique({ where: { email } });
    if (m) {
      await prisma.storeManager.deleteMany({ where: { adminUserId: m.id } });
      await prisma.adminUser.delete({ where: { id: m.id } });
    }
    await prisma.auditLog.deleteMany({ where: { details: { contains: 'P201 Manager' } } });
    await prisma.$disconnect();
  });

  const expectAppError = async (promise: Promise<unknown>, status: number, errorCode: string) => {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect({ status: error.status, errorCode: error.errorCode }).toEqual({ status, errorCode });
  };

  const auditCount = (action: string) => prisma.auditLog.count({ where: { action, details: { contains: 'P201 Manager' } } });

  it('creates a manager with a hashed password, store assignment and audit entry', async () => {
    const created = await createManager(actorId, { name: 'P201 Manager', email, password: 'Secret#123', storeId: storeA.id });
    managerId = created.id;
    expect(created).toMatchObject({ role: 'STORE_MANAGER', isActive: true, storeId: storeA.id, storeIdString: storeA.storeId });
    expect(created).not.toHaveProperty('passwordHash');

    const stored = await prisma.adminUser.findUniqueOrThrow({ where: { id: managerId } });
    expect(stored.passwordHash).not.toBe('Secret#123');
    expect(await bcrypt.compare('Secret#123', stored.passwordHash)).toBe(true);
    expect(await auditCount('MANAGER_CREATED')).toBe(1);
  });

  it('rejects duplicate emails and unknown stores', async () => {
    await expectAppError(createManager(actorId, { name: 'X', email, password: 'x', storeId: storeA.id }), 400, 'DUPLICATE_EMAIL');
    await expectAppError(
      createManager(actorId, { name: 'X', email: 'other.p201@uniquebasket.com', password: 'x', storeId: '00000000-0000-0000-0000-000000000000' }),
      400,
      'STORE_NOT_FOUND',
    );
    await expectAppError(updateManager(actorId, managerId, { email: 'superadmin@uniquebasket.com' }), 400, 'DUPLICATE_EMAIL');
  });

  it('reassigns the store only when it changes, with audit entries', async () => {
    await updateManager(actorId, managerId, { storeId: storeA.id });
    expect(await auditCount('MANAGER_STORE_CHANGED')).toBe(0);

    const moved = await updateManager(actorId, managerId, { storeId: storeB.id });
    expect(moved.storeId).toBe(storeB.id);
    expect(await auditCount('MANAGER_STORE_CHANGED')).toBe(1);
    expect(await prisma.storeManager.count({ where: { adminUserId: managerId } })).toBe(1);
  });

  it('updates password and active flag', async () => {
    await updateManager(actorId, managerId, { password: 'NewSecret#456', isActive: false });
    const stored = await prisma.adminUser.findUniqueOrThrow({ where: { id: managerId } });
    expect(await bcrypt.compare('NewSecret#456', stored.passwordHash)).toBe(true);
    expect(stored.isActive).toBe(false);
    expect(await auditCount('MANAGER_DEACTIVATED')).toBe(1);
  });

  it('only treats STORE_MANAGER accounts as managers', async () => {
    await expectAppError(getManager(actorId), 404, 'MANAGER_NOT_FOUND');
    await expectAppError(updateManager(actorId, actorId, { name: 'Nope' }), 404, 'MANAGER_NOT_FOUND');
    expect((await getManager(managerId)).storeAddress).toEqual(expect.any(String));
  });

  it('lists managers with filters and optional paging', async () => {
    const list = (await listManagers({ search: 'p201.manager' }, null)) as { id: string }[];
    expect(list.map((m) => m.id)).toEqual([managerId]);
    const paged = await listManagers({ isActive: 'false' }, { page: 1, limit: 5, skip: 0 });
    expect(paged).toMatchObject({ pagination: { page: 1, limit: 5 } });
  });
});
