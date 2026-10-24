import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { parsePagination, MAX_PAGE_LIMIT } from '../src/utils/pagination';

// P2-07: opt-in server-side pagination for products, categories, stores and managers.
describe('Admin list pagination (P2-07)', () => {
  let superToken: string;
  let managerToken: string;
  let customerToken: string;
  const customerPhone = '+919888800207';

  beforeAll(async () => {
    const superAdmin = await prisma.adminUser.findUnique({ where: { email: 'superadmin@uniquebasket.com' } });
    superToken = generateAccessToken({ id: superAdmin!.id, role: 'SUPER_ADMIN', email: superAdmin!.email });

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
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Paging Customer' },
    });
    customerToken = generateAccessToken({ id: customer.id, role: 'customer' });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone: customerPhone } });
    await prisma.$disconnect();
  });

  const get = (path: string, token: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  describe('parsePagination', () => {
    it('is opt-in and clamps invalid values', () => {
      expect(parsePagination({})).toBeNull();
      expect(parsePagination({ page: '2', limit: '5' })).toEqual({ page: 2, limit: 5, skip: 5 });
      expect(parsePagination({ page: '-1', limit: 'abc' })).toEqual({ page: 1, limit: 20, skip: 0 });
      expect(parsePagination({ limit: '100000' })!.limit).toEqual(MAX_PAGE_LIMIT);
    });
  });

  it('keeps the plain-array response when page/limit are absent', async () => {
    for (const path of ['/products', '/categories', '/admin/stores', '/admin/managers']) {
      const res = await get(path, superToken);
      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
    const customerRes = await get('/categories', customerToken);
    expect(Array.isArray(customerRes.body.data)).toBe(true);
  });

  it.each([
    ['/products', 'products', () => prisma.product.count()],
    ['/categories', 'categories', () => prisma.category.count()],
    ['/admin/stores', 'stores', () => prisma.store.count()],
    ['/admin/managers', 'managers', () => prisma.adminUser.count({ where: { role: 'STORE_MANAGER' } })],
  ])('paginates %s without overlap and reports totals', async (path, key, countFn) => {
    const total = await countFn();
    const limit = 2;
    const seen = new Set<string>();
    const pages = Math.max(1, Math.ceil(total / limit));

    for (let page = 1; page <= pages; page++) {
      const res = await get(`${path}?page=${page}&limit=${limit}`, superToken);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.pagination).toEqual({ total, page, limit, totalPages: Math.ceil(total / limit) });
      const items = res.body.data[key] as { id: string }[];
      expect(items.length).toBeLessThanOrEqual(limit);
      for (const item of items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
    }
    expect(seen.size).toEqual(total);
  });

  it('applies server-side filters before paginating', async () => {
    const inactive = await prisma.product.count({ where: { isActive: false } });
    const res = await get('/products?page=1&limit=50&isActive=false', superToken);
    expect(res.body.data.pagination.total).toEqual(inactive);
    expect(res.body.data.products.every((p: { isActive: boolean }) => !p.isActive)).toBe(true);

    const store = await prisma.store.findFirstOrThrow({ orderBy: { storeId: 'asc' } });
    const storeRes = await get(`/admin/stores?page=1&limit=10&search=${encodeURIComponent(store.storeId)}`, superToken);
    expect(storeRes.body.data.stores.map((s: { id: string }) => s.id)).toContain(store.id);
    expect(storeRes.body.data.cities).toContain(store.city.trim());

    const mgrRes = await get('/admin/managers?page=1&limit=10&search=manager1@', superToken);
    expect(mgrRes.body.data.managers).toHaveLength(1);
    expect(mgrRes.body.data.pagination.total).toEqual(1);
  });

  it('only shows customers active categories even when paginated', async () => {
    const active = await prisma.category.count({ where: { isActive: true } });
    const res = await get('/categories?page=1&limit=100', customerToken);
    expect(res.body.data.pagination.total).toEqual(active);
  });

  it('keeps store-manager isolation on the paginated store list', async () => {
    const res = await get('/admin/stores?page=1&limit=10', managerToken);
    expect(res.statusCode).toEqual(200);
    expect(res.body.data.stores).toHaveLength(1);
    expect(res.body.data.pagination.total).toEqual(1);

    const page2 = await get('/admin/stores?page=2&limit=10', managerToken);
    expect(page2.body.data.stores).toHaveLength(0);
  });
});
