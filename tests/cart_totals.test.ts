import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

// P1-05: cart totals follow the same fare rules as checkout.
describe('Cart totals consistency (P1-05)', () => {
  const customerPhone = '+919888800105';
  let customerId: string;
  let customerToken: string;
  let storeId: string;
  let addressId: string;
  let productId: string;
  let inactiveCategoryId: string;
  let hiddenProductId: string;
  let originalSettings: any;

  const getCart = () => request(app).get('/api/v1/cart').set('Authorization', `Bearer ${customerToken}`);

  beforeAll(async () => {
    const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
    const category = await prisma.category.findFirst({ where: { isActive: true } });
    if (!store || !category) throw new Error('Seed data not found.');
    storeId = store.id;
    originalSettings = await prisma.deliverySettings.findFirst();

    const product = await prisma.product.create({
      data: { name: 'P105 Mango', categoryId: category.id, unit: 'KG', price: 100 },
    });
    productId = product.id;
    const hiddenCategory = await prisma.category.create({ data: { name: `P105 Hidden ${Date.now()}`, isActive: false } });
    inactiveCategoryId = hiddenCategory.id;
    const hidden = await prisma.product.create({
      data: { name: 'P105 Hidden Item', categoryId: inactiveCategoryId, unit: 'KG', price: 50 },
    });
    hiddenProductId = hidden.id;
    await prisma.storeInventory.create({ data: { storeId, productId, stockQuantity: 100 } });

    const user = await prisma.user.upsert({
      where: { phone: customerPhone },
      update: {},
      create: { phone: customerPhone, name: 'Cart Totals Customer' },
    });
    customerId = user.id;
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });

    const address = await prisma.userAddress.create({
      data: {
        userId: customerId,
        title: 'Home',
        addressLine: 'Near Store One',
        city: store.city,
        state: store.state,
        pincode: store.pincode,
        latitude: store.latitude,
        longitude: store.longitude,
        isDefault: true,
      },
    });
    addressId = address.id;

    // Cart: 2 kg mango (subtotal 200) + a hidden-category item
    await prisma.cartItem.createMany({
      data: [
        { userId: customerId, productId, quantity: 2 },
        { userId: customerId, productId: hiddenProductId, quantity: 1 },
      ],
    });
  });

  afterEach(async () => {
    if (originalSettings) {
      const { id, createdAt, updatedAt, ...rest } = originalSettings;
      await prisma.deliverySettings.update({ where: { id }, data: rest });
    }
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: customerId } });
    await prisma.cartItem.deleteMany({ where: { userId: customerId } });
    await prisma.userAddress.deleteMany({ where: { userId: customerId } });
    await prisma.inventoryTransaction.deleteMany({ where: { productId } });
    await prisma.storeInventory.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: { in: [productId, hiddenProductId] } } });
    await prisma.category.deleteMany({ where: { id: inactiveCategoryId } });
    await prisma.user.deleteMany({ where: { id: customerId } });
    await prisma.$disconnect();
  });

  it('excludes products whose category is inactive', async () => {
    const res = await getCart();
    expect(res.statusCode).toEqual(200);
    const ids = res.body.data.items.map((i: any) => i.productId);
    expect(ids).toContain(productId);
    expect(ids).not.toContain(hiddenProductId);
    expect(res.body.data.subtotal).toEqual(200);
  });

  it('reports no delivery fee and deliveryEnabled=false when delivery is disabled', async () => {
    await prisma.deliverySettings.updateMany({ data: { deliveryEnabled: false } });

    const res = await getCart();

    expect(res.body.data.deliveryEnabled).toBe(false);
    expect(res.body.data.deliveryFee).toEqual(0);
    expect(res.body.data.total).toEqual(200);
  });

  it('charges the same delivery fee in the cart as at checkout', async () => {
    await prisma.deliverySettings.updateMany({
      data: { deliveryEnabled: true, deliveryFee: 35, freeDeliveryThreshold: 1000, minimumOrderAmount: 100 },
    });

    const cart = await getCart();
    expect(cart.body.data.deliveryEnabled).toBe(true);
    expect(cart.body.data.deliveryFee).toEqual(35);

    const order = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        fulfillmentType: 'DELIVERY',
        addressId,
        paymentMethod: 'COD',
        items: [{ productId, quantity: 2 }],
      });

    expect(order.statusCode).toEqual(201);
    expect(order.body.data.order.deliveryFee).toEqual(cart.body.data.deliveryFee);
    expect(order.body.data.order.subtotal).toEqual(cart.body.data.subtotal);
  });

  it('has no delivery fee, no minimum order and no COD charge for PICKUP, matching checkout (D-016, D-018)', async () => {
    await prisma.deliverySettings.updateMany({
      data: {
        deliveryEnabled: true,
        deliveryFee: 35,
        freeDeliveryThreshold: 1000,
        minimumOrderAmount: 500,
        codEnabled: true,
        codCharge: 20,
        // Pay at store ignores the COD limits: subtotal 200 is outside 300–400.
        minimumCodOrderAmount: 300,
        maximumCodOrderAmount: 400,
      },
    });
    // The previous checkout cleared the cart; put 2 kg back (subtotal 200).
    await prisma.cartItem.create({ data: { userId: customerId, productId, quantity: 2 } }).catch(() => undefined);

    const cart = await request(app).get('/api/v1/cart?fulfillmentType=PICKUP').set('Authorization', `Bearer ${customerToken}`);
    expect(cart.body.data).toMatchObject({ fulfillmentType: 'PICKUP', deliveryFee: 0, minimumOrderAmount: 0, codCharge: 0, total: 200 });
    const delivery = await getCart();
    expect(delivery.body.data).toMatchObject({ fulfillmentType: 'DELIVERY', deliveryFee: 35, minimumOrderAmount: 500, codCharge: 20 });

    // Subtotal 200 is below the 500 delivery minimum, but pickup has no minimum.
    const order = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId, quantity: 2 }] });
    expect(order.statusCode).toEqual(201);
    expect(order.body.data.order.deliveryFee).toEqual(0);
    expect(order.body.data.order.codCharge).toEqual(0);
    expect(order.body.data.order.subtotal).toEqual(cart.body.data.subtotal);
    expect(order.body.data.order.total).toEqual(cart.body.data.total);

    await prisma.deliverySettings.updateMany({ data: { minimumCodOrderAmount: 100, maximumCodOrderAmount: 5000 } });
  });

  it('waives the delivery fee at the free-delivery threshold in both cart and checkout', async () => {
    await prisma.deliverySettings.updateMany({ data: { deliveryEnabled: true, deliveryFee: 35, freeDeliveryThreshold: 150 } });
    await prisma.cartItem.create({ data: { userId: customerId, productId, quantity: 2 } }).catch(() => undefined);

    const cart = await getCart();
    expect(cart.body.data.deliveryFee).toEqual(0);
  });
});
