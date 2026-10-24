import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P1-02: deleting an address must not erase the delivery address of past orders.
describe('Order delivery address snapshot (P1-02)', () => {
  const phone = '+919888800102';
  let customerId: string;
  let customerToken: string;
  let adminToken: string;
  let productId: string;
  let storeId: string;

  beforeAll(async () => {
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const admin = await prisma.adminUser.findUnique({ where: { email: 'superadmin@uniquebasket.com' } });
    const category = await prisma.category.findFirst({ where: { isActive: true } });
    if (!store || !admin || !category) throw new Error('Seed data not found.');
    storeId = store.id;

    const product = await prisma.product.create({
      data: { name: 'P102 Papaya', categoryId: category.id, unit: 'KG', price: 300 },
    });
    productId = product.id;
    await prisma.storeInventory.create({ data: { storeId, productId, stockQuantity: 50 } });

    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Snapshot Customer' } });
    customerId = user.id;
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone });
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.userAddress.deleteMany({ where: { userId: customerId } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  it('keeps the delivery address on the order after the address is deleted', async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    const address = await prisma.userAddress.create({
      data: {
        userId: customerId,
        title: 'Office',
        addressLine: '42 Snapshot Lane',
        city: store.city,
        state: store.state,
        pincode: store.pincode,
        latitude: store.latitude,
        longitude: store.longitude,
      },
    });

    const placed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fulfillmentType: 'DELIVERY', addressId: address.id, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
    expect(placed.statusCode).toEqual(201);
    const orderId = placed.body.data.order.id;

    // Customer deletes the address
    const del = await request(app)
      .delete(`/api/v1/customer/addresses/${address.id}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(del.statusCode).toEqual(200);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(dbOrder.addressId).toBeNull();

    const customerView = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(customerView.statusCode).toEqual(200);
    expect(customerView.body.data.address).toMatchObject({ title: 'Office', addressLine: '42 Snapshot Lane', pincode: store.pincode });

    const adminView = await request(app)
      .get(`/api/v1/admin/orders/${orderId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminView.statusCode).toEqual(200);
    expect(adminView.body.data.address).toMatchObject({ addressLine: '42 Snapshot Lane' });

    const paymentView = await request(app)
      .get(`/api/v1/admin/payments/${orderId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(paymentView.statusCode).toEqual(200);
    expect(paymentView.body.data.deliveryAddress).toMatchObject({ addressLine: '42 Snapshot Lane' });
  });

  it('shows the address as it was when ordered, even after the customer edits it, with the GPS flag', async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    const address = await prisma.userAddress.create({
      data: {
        userId: customerId, title: 'Home', addressLine: '7 Original Road', city: store.city, state: store.state,
        pincode: store.pincode, latitude: store.latitude, longitude: store.longitude,
      },
    });
    const placed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fulfillmentType: 'DELIVERY', addressId: address.id, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
    expect(placed.statusCode).toEqual(201);
    const orderId = placed.body.data.order.id;

    // Customer later edits the same saved address
    const edit = await request(app)
      .put(`/api/v1/customer/addresses/${address.id}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ addressLine: '99 Moved Street' });
    expect(edit.statusCode).toEqual(200);

    const expected = {
      addressLine: '7 Original Road',
      latitude: Number(store.latitude),
      longitude: Number(store.longitude),
      locationConfirmed: true,
    };
    const adminView = await request(app).get(`/api/v1/admin/orders/${orderId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(adminView.body.data.address).toMatchObject(expected);
    expect(adminView.body.data.store).toMatchObject({ latitude: expect.anything(), longitude: expect.anything() });
    const customerView = await request(app).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${customerToken}`);
    expect(customerView.body.data.address).toMatchObject(expected);
    const paymentView = await request(app).get(`/api/v1/admin/payments/${orderId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(paymentView.body.data.deliveryAddress).toMatchObject({ addressLine: '7 Original Road' });
  });

  it('marks a typed address without GPS as location not confirmed', async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    const typed = await request(app)
      .post('/api/v1/customer/addresses')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ title: 'Typed', addressLine: '3 Typed Lane', city: store.city, state: store.state, pincode: store.pincode });
    expect(typed.statusCode).toEqual(201);

    const placed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fulfillmentType: 'DELIVERY', addressId: typed.body.data.address.id, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
    expect(placed.statusCode).toEqual(201);
    const adminView = await request(app).get(`/api/v1/admin/orders/${placed.body.data.order.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(adminView.body.data.address.locationConfirmed).toBe(false);
  });

  it('does not store a snapshot for pickup orders', async () => {
    const placed = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
    expect(placed.statusCode).toEqual(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.order.id } });
    expect(order.deliveryAddressSnapshot).toBeNull();
  });
});
