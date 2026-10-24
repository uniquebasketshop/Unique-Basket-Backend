import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// D-017: real GPS coordinates vs typed addresses ("location not confirmed"), and store selection
// (serviceability rule iii: pincode list + store radius when the location is confirmed).
describe('Address location (D-017)', () => {
  const phone = '+919888800017';
  const testPincode = '360917';
  let token: string;
  let userId: string;
  let storeOne: { id: string; latitude: unknown; longitude: unknown; pincode: string };
  let pincodeStoreId: string;
  let productId: string;

  const api = (method: 'get' | 'post' | 'put', url: string) =>
    request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);

  const placeDeliveryOrder = (addressId: string) =>
    api('post', '/orders').send({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'COD', items: [{ productId, quantity: 3 }] });

  beforeAll(async () => {
    const store = await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } });
    storeOne = store;
    const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });

    // A serviceable pincode served by its own active store, far from STORE-001.
    await prisma.supportedPincode.upsert({ where: { pincode: testPincode }, update: { isActive: true }, create: { pincode: testPincode } });
    const pincodeStore = await prisma.store.create({
      data: {
        storeId: 'STORE-D017',
        name: 'D017 Pincode Store',
        address: 'Test Road',
        city: 'Rajkot',
        state: 'Gujarat',
        pincode: testPincode,
        latitude: 23.5,
        longitude: 72.5,
        deliveryRadiusKm: 5,
        phone: '+919000000017',
        openingTime: '09:00',
        closingTime: '21:00',
      },
    });
    pincodeStoreId = pincodeStore.id;

    const product = await prisma.product.create({ data: { name: 'D017 Banana', categoryId: category.id, unit: 'KG', price: 100 } });
    productId = product.id;
    await prisma.storeInventory.createMany({
      data: [
        { storeId: store.id, productId, stockQuantity: 100 },
        { storeId: pincodeStoreId, productId, stockQuantity: 100 },
      ],
    });

    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Location Customer' } });
    userId = user.id;
    token = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.cartItem.deleteMany({ where: { userId } });
    await prisma.userAddress.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.store.deleteMany({ where: { id: pincodeStoreId } });
    await prisma.supportedPincode.deleteMany({ where: { pincode: testPincode } });
    await prisma.$disconnect();
  });

  it('marks typed addresses as location not confirmed and GPS addresses as confirmed', async () => {
    const typed = await api('post', '/customer/addresses').send({ addressLine: '1 Typed Street', pincode: storeOne.pincode });
    expect(typed.statusCode).toBe(201);
    expect(typed.body.data.locationConfirmed ?? typed.body.data.address?.locationConfirmed).toBe(false);

    const gps = await api('post', '/customer/addresses').send({
      addressLine: '2 GPS Street', pincode: storeOne.pincode, latitude: Number(storeOne.latitude) + 0.001, longitude: Number(storeOne.longitude),
    });
    expect(gps.body.data.locationConfirmed ?? gps.body.data.address?.locationConfirmed).toBe(true);

    // Only one coordinate sent → not confirmed
    const half = await api('post', '/customer/addresses').send({ addressLine: '3 Half Street', pincode: storeOne.pincode, latitude: 22.1 });
    expect(half.body.data.locationConfirmed ?? half.body.data.address?.locationConfirmed).toBe(false);

    const list = await api('get', '/customer/addresses');
    const byLine = (line: string) => (list.body.data.addresses ?? list.body.data).find((a: any) => a.addressLine === line);
    expect(byLine('1 Typed Street').locationConfirmed).toBe(false);
    expect(byLine('2 GPS Street').locationConfirmed).toBe(true);
  });

  it('confirms the location when both coordinates are updated', async () => {
    const typed = await api('post', '/customer/addresses').send({ addressLine: '4 Confirm Street', pincode: storeOne.pincode });
    const id = typed.body.data.id ?? typed.body.data.address?.id;
    const res = await api('put', `/customer/addresses/${id}`).send({ latitude: Number(storeOne.latitude), longitude: Number(storeOne.longitude) + 0.002 });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.locationConfirmed ?? res.body.data.address?.locationConfirmed).toBe(true);
  });

  it('delivers a typed address from the store in its pincode', async () => {
    const typed = await api('post', '/customer/addresses').send({ addressLine: '5 Pincode Street', pincode: testPincode });
    const id = typed.body.data.id ?? typed.body.data.address?.id;
    const order = await placeDeliveryOrder(id);
    expect(order.statusCode).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.body.data.order.id } })).storeId).toBe(pincodeStoreId);
  });

  it('delivers a confirmed address from the nearest store in range, and refuses one out of range', async () => {
    const near = await api('post', '/customer/addresses').send({
      addressLine: '6 Near Street', pincode: testPincode, latitude: Number(storeOne.latitude) + 0.001, longitude: Number(storeOne.longitude),
    });
    const nearOrder = await placeDeliveryOrder(near.body.data.id ?? near.body.data.address?.id);
    expect(nearOrder.statusCode).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: nearOrder.body.data.order.id } })).storeId).toBe(storeOne.id);

    const far = await api('post', '/customer/addresses').send({
      addressLine: '7 Far Street', pincode: storeOne.pincode, latitude: 12.97, longitude: 77.59,
    });
    const farOrder = await placeDeliveryOrder(far.body.data.id ?? far.body.data.address?.id);
    expect(farOrder.statusCode).toBe(400);
    expect(farOrder.body.errorCode).toBe('NO_DELIVERY_AVAILABLE');
  });
});
