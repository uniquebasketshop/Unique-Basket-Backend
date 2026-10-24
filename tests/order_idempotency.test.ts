import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

/**
 * Duplicate-order protection: an Idempotency-Key header makes one checkout attempt
 * create at most one order (retries after a timeout, double submits).
 */
describe('Order creation idempotency (Idempotency-Key)', () => {
  let customerId: string;
  let customerToken: string;
  let otherCustomerId: string;
  let otherToken: string;
  let storeId: string;
  let appleProductId: string;
  let addressId: string;
  let otherAddressId: string;

  const orderBody = () => ({
    fulfillmentType: 'DELIVERY',
    addressId,
    paymentMethod: 'COD',
    items: [{ productId: appleProductId, quantity: 2 }],
  });

  const stock = async () => {
    const inv = await prisma.storeInventory.findUnique({
      where: { storeId_productId: { storeId, productId: appleProductId } },
    });
    return Number(inv?.stockQuantity);
  };

  const makeCustomer = async (phone: string) => {
    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, name: 'Idempotency Test Customer' },
    });
    const address = await prisma.userAddress.create({
      data: {
        userId: user.id,
        title: 'Near Store One',
        addressLine: 'Nana Mava Road',
        city: 'Rajkot',
        state: 'Gujarat',
        pincode: '360005',
        latitude: 22.308155,
        longitude: 70.800705,
      },
    });
    const token = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
    return { id: user.id, token, addressId: address.id };
  };

  const cleanupCustomer = async (userId: string) => {
    await prisma.orderItem.deleteMany({ where: { order: { userId } } });
    await prisma.payment.deleteMany({ where: { order: { userId } } });
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.userAddress.deleteMany({ where: { userId } });
    await prisma.cartItem.deleteMany({ where: { userId } });
  };

  beforeAll(async () => {
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    if (!store) throw new Error('Seeded central store STORE-001 not found.');
    storeId = store.id;

    const apple = await prisma.product.findFirst({ where: { name: { startsWith: 'Apple' } } });
    if (!apple) throw new Error('Seeded Apple product not found.');
    appleProductId = apple.id;

    await prisma.storeInventory.upsert({
      where: { storeId_productId: { storeId, productId: appleProductId } },
      update: { stockQuantity: 100 },
      create: { storeId, productId: appleProductId, stockQuantity: 100 },
    });

    const customer = await makeCustomer('+919999955501');
    customerId = customer.id;
    customerToken = customer.token;
    addressId = customer.addressId;

    const other = await makeCustomer('+919999955502');
    otherCustomerId = other.id;
    otherToken = other.token;
    otherAddressId = other.addressId;
  });

  afterAll(async () => {
    await cleanupCustomer(customerId);
    await cleanupCustomer(otherCustomerId);
    await prisma.auditLog.deleteMany({ where: { action: 'CREATE_ORDER' } });
    await prisma.$disconnect();
  });

  it('1. a retry with the same key returns the same order and takes stock once', async () => {
    const before = await stock();
    const key = 'retry-key-0001';

    const first = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send(orderBody());
    expect(first.statusCode).toEqual(201);

    const retry = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send(orderBody());
    expect(retry.statusCode).toEqual(200);
    expect(retry.body.success).toBe(true);
    expect(retry.body.data.order).toEqual(first.body.data.order);

    expect(await prisma.order.count({ where: { userId: customerId, idempotencyKey: key } })).toEqual(1);
    expect(await stock()).toEqual(before - 2);
  });

  it('2. two requests with the same key at the same time create one order', async () => {
    const before = await stock();
    const key = 'concurrent-key-0002';

    const send = () =>
      request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send(orderBody());
    const [a, b] = await Promise.all([send(), send()]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.body.data.order.id).toEqual(b.body.data.order.id);
    expect(await prisma.order.count({ where: { userId: customerId, idempotencyKey: key } })).toEqual(1);
    expect(await stock()).toEqual(before - 2);
  });

  it('3. different keys create different orders', async () => {
    const send = (key: string) =>
      request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send(orderBody());

    const a = await send('distinct-key-0003a');
    const b = await send('distinct-key-0003b');
    expect(a.statusCode).toEqual(201);
    expect(b.statusCode).toEqual(201);
    expect(a.body.data.order.id).not.toEqual(b.body.data.order.id);
  });

  it('4. without a key every request creates an order (existing clients keep working)', async () => {
    const before = await prisma.order.count({ where: { userId: customerId } });
    const send = () =>
      request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(orderBody());

    expect((await send()).statusCode).toEqual(201);
    expect((await send()).statusCode).toEqual(201);
    expect(await prisma.order.count({ where: { userId: customerId } })).toEqual(before + 2);
  });

  it('5. the same key from another customer creates that customer\'s own order', async () => {
    const key = 'shared-key-0005';
    const mine = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send(orderBody());
    const theirs = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', key)
      .send({ ...orderBody(), addressId: otherAddressId });

    expect(mine.statusCode).toEqual(201);
    expect(theirs.statusCode).toEqual(201);
    expect(theirs.body.data.order.id).not.toEqual(mine.body.data.order.id);
  });

  it('6. a failed attempt does not use up the key', async () => {
    const key = 'failed-then-ok-0006';
    const failed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send({ ...orderBody(), items: [{ productId: appleProductId, quantity: 10000 }] });
    expect(failed.statusCode).toEqual(400);
    expect(failed.body.errorCode).toEqual('INSUFFICIENT_STOCK');

    const ok = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send(orderBody());
    expect(ok.statusCode).toEqual(201);
  });

  it.each(['short', 'has spaces in key', 'a'.repeat(65), 'bad*chars!key'])(
    '7. rejects an invalid key %p',
    async (key) => {
      const before = await prisma.order.count({ where: { userId: customerId } });
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('Idempotency-Key', key)
        .send(orderBody());

      expect(res.statusCode).toEqual(400);
      expect(res.body).toMatchObject({ success: false, errorCode: 'INVALID_IDEMPOTENCY_KEY' });
      expect(await prisma.order.count({ where: { userId: customerId } })).toEqual(before);
    },
  );
});
