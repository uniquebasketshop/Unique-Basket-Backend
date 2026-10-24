import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { createSuperAdmin } from '../src/services/superAdminService';

/** First Super Admin on a live database: `npm run admin:create` (never deletes data). */
describe('Create Super Admin command', () => {
  const email = `owner-${Date.now()}@uniquebasket.com`;
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'NO_ERROR';
    } catch (error) {
      return (error as { errorCode?: string }).errorCode;
    }
  };

  afterAll(async () => {
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (admin) {
      await prisma.auditLog.deleteMany({ where: { adminUserId: admin.id } });
      await prisma.refreshToken.deleteMany({ where: { adminUserId: admin.id } });
      await prisma.adminUser.delete({ where: { id: admin.id } });
    }
    await prisma.$disconnect();
  });

  it('refuses when a Super Admin already exists, unless another one is explicitly allowed', async () => {
    expect(await prisma.adminUser.count({ where: { role: 'SUPER_ADMIN' } })).toBeGreaterThan(0);
    expect(await codeOf(createSuperAdmin({ email, name: 'Owner', password: 'Strong#2026' }))).toEqual('SUPER_ADMIN_EXISTS');
    expect(await prisma.adminUser.findUnique({ where: { email } })).toBeNull();
  });

  it.each([
    [{ email: 'not-an-email', name: 'Owner', password: 'Strong#2026' }, 'INVALID_EMAIL'],
    [{ email: 'x@y.com', name: '  ', password: 'Strong#2026' }, 'INVALID_NAME'],
    [{ email: 'x@y.com', name: 'Owner', password: 'weakpass' }, 'WEAK_PASSWORD'],
    [{ email: 'superadmin@uniquebasket.com', name: 'Owner', password: 'Strong#2026' }, 'DUPLICATE_EMAIL'],
  ])('rejects invalid input %#', async (input, code) => {
    expect(await codeOf(createSuperAdmin(input, { allowAdditional: true }))).toEqual(code);
  });

  it('creates a working Super Admin (hashed password, audit entry) without touching other data', async () => {
    const before = { stores: await prisma.store.count(), products: await prisma.product.count(), admins: await prisma.adminUser.count() };

    const admin = await createSuperAdmin({ email: `  ${email.toUpperCase()} `, name: ' Owner ', password: 'Strong#2026' }, { allowAdditional: true });
    expect(admin).toMatchObject({ email, name: 'Owner', role: 'SUPER_ADMIN' });

    const stored = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).not.toContain('Strong#2026');
    expect(await prisma.auditLog.count({ where: { adminUserId: stored.id, action: 'CREATE_SUPER_ADMIN' } })).toEqual(1);
    expect({ stores: await prisma.store.count(), products: await prisma.product.count(), admins: await prisma.adminUser.count() }).toEqual({
      ...before,
      admins: before.admins + 1,
    });

    const login = await request(app).post('/api/v1/admin/login').send({ email, password: 'Strong#2026' });
    expect(login.statusCode).toEqual(200);
    expect(login.body.data.admin.role).toEqual('SUPER_ADMIN');
  });
});
