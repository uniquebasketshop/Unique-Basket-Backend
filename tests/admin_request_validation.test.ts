import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P2-01 part 2: admin endpoints use validateBody with their existing error codes.
describe('Admin request validation (P2-01)', () => {
  let token: string;
  let storeId: string;
  let productId: string;
  let managerId: string;
  let customerId: string;
  let orderId: string | undefined;
  let pincodeId: string;
  let categoryId: string;
  let bannerId: string;

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    token = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    storeId = (await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } })).id;
    productId = (await prisma.product.findFirstOrThrow()).id;
    managerId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager1@uniquebasket.com' } })).id;
    customerId = (await prisma.user.upsert({ where: { phone: '+919777700902' }, update: {}, create: { phone: '+919777700902' } })).id;
    orderId = (await prisma.order.findFirst())?.id;
    pincodeId = (await prisma.supportedPincode.findFirstOrThrow()).id;
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    bannerId = (await prisma.banner.create({ data: { imageUrl: 'https://example.com/p201.png', title: 'P201' } })).id;
  });

  afterAll(async () => {
    await prisma.banner.deleteMany({ where: { id: bannerId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  const send = (method: 'post' | 'put' | 'patch', path: string, body: unknown) =>
    request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body as object);

  const expect400 = async (method: 'post' | 'put' | 'patch', path: string, body: unknown, errorCode: string) => {
    const res = await send(method, path, body);
    expect({ path, body, status: res.statusCode, errorCode: res.body.errorCode }).toEqual({ path, body, status: 400, errorCode });
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe('string');
  };

  it('admin login requires both credentials', async () => {
    const res = await request(app).post('/api/v1/admin/login').send({ email: 'superadmin@uniquebasket.com' });
    expect(res.statusCode).toEqual(400);
    expect(res.body.errorCode).toBe('MISSING_CREDENTIALS');
  });

  it('order status and pickup verification', async () => {
    await expect400('put', `/admin/orders/${orderId ?? '00000000-0000-0000-0000-000000000000'}/status`, { status: 'SHIPPED' }, 'INVALID_STATUS');
    await expect400('put', `/admin/orders/${orderId ?? '00000000-0000-0000-0000-000000000000'}/status`, {}, 'INVALID_STATUS');
    await expect400('post', '/admin/orders/pickup-verify', { orderNumber: 'X' }, 'MISSING_PARAMETERS');
  });

  it('fare & COD settings reject non-numeric amounts and non-boolean flags', async () => {
    const before = await prisma.deliverySettings.findFirstOrThrow();
    await expect400('put', '/admin/settings/fare-cod', { deliveryFee: 'abc' }, 'INVALID_SETTINGS_VALUES');
    // "false" used to be coerced to true with Boolean("false")
    await expect400('put', '/admin/settings/fare-cod', { codEnabled: 'false' }, 'INVALID_SETTINGS_VALUES');
    await expect400('put', '/admin/settings/fare-cod', { codCharge: -5 }, 'NEGATIVE_VALUES_NOT_ALLOWED');
    await expect400('put', '/admin/settings/fare-cod', { minimumCodOrderAmount: 900, maximumCodOrderAmount: 100 }, 'INVALID_COD_RANGE');
    const after = await prisma.deliverySettings.findFirstOrThrow();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('manager create/update', async () => {
    await expect400('post', '/admin/managers', { name: 'X', email: 'x@example.com', storeId }, 'MISSING_PARAMETERS');
    await expect400('post', '/admin/managers', { name: 'X', email: 'not-an-email', password: 'secret123', storeId }, 'INVALID_EMAIL');
    // Update used to accept any email string
    await expect400('put', `/admin/managers/${managerId}`, { email: 'not-an-email' }, 'INVALID_EMAIL');
    await expect400('put', `/admin/managers/${managerId}`, { isActive: 'no' }, 'VALIDATION_ERROR');
  });

  it('customer status requires a boolean', async () => {
    await expect400('put', `/admin/customers/${customerId}/status`, { isActive: 'false' }, 'INVALID_PARAMETERS');
  });

  it('stores validate required fields, pincode, coordinates and radius', async () => {
    const valid = {
      storeId: 'P201-STORE',
      name: 'P201 Store',
      address: '1 Road',
      city: 'Rajkot',
      state: 'Gujarat',
      pincode: '360001',
      latitude: '22.3',
      longitude: '70.8',
      deliveryRadiusKm: '10',
      phone: '+91 98765 00000',
      openingTime: '08:00',
      closingTime: '22:00',
    };
    await expect400('post', '/admin/stores', { ...valid, phone: undefined }, 'MISSING_PARAMETERS');
    await expect400('post', '/admin/stores', { ...valid, pincode: '3600' }, 'INVALID_PINCODE');
    await expect400('post', '/admin/stores', { ...valid, latitude: '123' }, 'INVALID_COORDINATES');
    await expect400('post', '/admin/stores', { ...valid, deliveryRadiusKm: '0' }, 'VALIDATION_ERROR');
    await expect400('post', '/admin/stores', { ...valid, email: 'bad' }, 'INVALID_EMAIL');
    await expect400('put', `/admin/stores/${storeId}`, { longitude: 'east' }, 'INVALID_COORDINATES');
    await expect400('put', `/stores/${storeId}`, { isActive: 1 }, 'VALIDATION_ERROR');
    expect(await prisma.store.count({ where: { storeId: 'P201-STORE' } })).toBe(0);
  });

  it('banners, pincodes and categories', async () => {
    await expect400('post', '/admin/banners', { title: 'No image' }, 'IMAGE_URL_REQUIRED');
    await expect400('put', `/admin/banners/${bannerId}`, { imageUrl: '  ' }, 'IMAGE_URL_REQUIRED');
    await expect400('put', `/admin/banners/${bannerId}`, { displayOrder: 1.5 }, 'VALIDATION_ERROR');
    await expect400('post', '/admin/pincodes', { pincode: '12ab56' }, 'INVALID_PINCODE_FORMAT');
    await expect400('put', `/admin/pincodes/${pincodeId}`, { pincode: '123' }, 'INVALID_PINCODE_FORMAT');
    await expect400('patch', `/admin/pincodes/${pincodeId}/status`, { isActive: 'off' }, 'VALIDATION_ERROR');
    await expect400('post', '/categories', { description: 'no name' }, 'MISSING_PARAMETERS');
    await expect400('put', `/categories/${categoryId}`, { displayOrder: 'first' }, 'VALIDATION_ERROR');
  });

  it('store inventory adjustments', async () => {
    const path = `/products/store/${storeId}/inventory/${productId}`;
    await expect400('put', path, { adjustmentType: 'DOUBLE', quantity: 1 }, 'INVALID_ADJUSTMENT_TYPE');
    await expect400('put', path, { adjustmentType: 'ADD' }, 'INVALID_QUANTITY');
    await expect400('put', path, { adjustmentType: 'ADD', quantity: -1 }, 'INVALID_QUANTITY');
    await expect400('put', path, { stockQuantity: 'many' }, 'INVALID_QUANTITY');
    await expect400('put', path, { isAvailable: 'yes' }, 'VALIDATION_ERROR');
    await expect400('put', path, { lowStockThreshold: -2 }, 'VALIDATION_ERROR');
  });

  it('valid admin updates still succeed', async () => {
    const res = await send('put', `/admin/banners/${bannerId}`, { title: 'P201 updated', displayOrder: '3', isActive: false });
    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toMatchObject({ title: 'P201 updated', displayOrder: 3, isActive: false });
  });
});
