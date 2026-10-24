import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { MAX_ORDER_LINES } from '../src/services/orderService';

/**
 * Security review, FEATURES sections D (catalogue), E (cart & checkout) and F (orders):
 * hidden products stay hidden, the client can't set prices or fees, quantity and item rules
 * hold, and a customer can't touch another customer's cart, address or order.
 */
describe('Catalogue, checkout and order security (D, E, F)', () => {
  const phoneA = '+919888800601';
  const phoneB = '+919888800602';
  const tag = `SEC-${Date.now()}`;
  let storeId: string;
  let inactiveStoreId: string;
  let categoryId: string;
  let hiddenCategoryId: string;
  let productId: string; // KG, ₹50, max 5 kg per order
  let inactiveProductId: string;
  let hiddenCategoryProductId: string;
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  let adminToken: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const stock = async () =>
    Number((await prisma.storeInventory.findUniqueOrThrow({ where: { storeId_productId: { storeId, productId } } })).stockQuantity);
  const pickupOrder = (token: string, items: unknown[], extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/orders')
      .set(as(token))
      .send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items, ...extra });

  beforeAll(async () => {
    storeId = (await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } })).id;
    inactiveStoreId = (
      await prisma.store.create({
        data: {
          storeId: `${tag}-OFF`, name: 'Closed Test Store', address: '1 Road', city: 'Rajkot', state: 'Gujarat',
          pincode: '360005', latitude: 22.3, longitude: 70.8, phone: '+919000000000', openingTime: '09:00',
          closingTime: '21:00', isActive: false,
        },
      })
    ).id;

    categoryId = (await prisma.category.create({ data: { name: `${tag} Fruits` } })).id;
    hiddenCategoryId = (await prisma.category.create({ data: { name: `${tag} Hidden`, isActive: false } })).id;

    const product = await prisma.product.create({
      data: { name: `${tag} Mango`, categoryId, unit: 'KG', price: 50, minQuantity: 0.5, maxQuantity: 5, quantityStep: 0.5 },
    });
    productId = product.id;
    inactiveProductId = (await prisma.product.create({ data: { name: `${tag} Old`, categoryId, unit: 'KG', price: 10, isActive: false } })).id;
    hiddenCategoryProductId = (await prisma.product.create({ data: { name: `${tag} InHidden`, categoryId: hiddenCategoryId, unit: 'KG', price: 10 } })).id;
    for (const id of [productId, inactiveProductId, hiddenCategoryProductId]) {
      await prisma.storeInventory.create({ data: { storeId, productId: id, stockQuantity: 100 } });
    }

    const a = await prisma.user.upsert({ where: { phone: phoneA }, update: {}, create: { phone: phoneA, name: 'Buyer A' } });
    const b = await prisma.user.upsert({ where: { phone: phoneB }, update: {}, create: { phone: phoneB, name: 'Buyer B' } });
    userA = a.id;
    userB = b.id;
    tokenA = generateAccessToken({ id: a.id, role: 'customer', phone: phoneA });
    tokenB = generateAccessToken({ id: b.id, role: 'customer', phone: phoneB });
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
  });

  afterAll(async () => {
    const users = [userA, userB];
    await prisma.orderItem.deleteMany({ where: { order: { userId: { in: users } } } });
    await prisma.order.deleteMany({ where: { userId: { in: users } } });
    await prisma.cartItem.deleteMany({ where: { userId: { in: users } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    const products = [productId, inactiveProductId, hiddenCategoryProductId];
    await prisma.inventoryTransaction.deleteMany({ where: { productId: { in: products } } });
    await prisma.storeInventory.deleteMany({ where: { productId: { in: products } } });
    await prisma.product.deleteMany({ where: { id: { in: products } } });
    await prisma.category.deleteMany({ where: { id: { in: [categoryId, hiddenCategoryId] } } });
    await prisma.store.deleteMany({ where: { id: inactiveStoreId } });
    await prisma.auditLog.deleteMany({ where: { action: 'CREATE_ORDER', details: { contains: userA } } });
    await prisma.$disconnect();
  });

  describe('catalogue (D)', () => {
    it('hides inactive products and products of inactive categories from customers', async () => {
      for (const id of [inactiveProductId, hiddenCategoryProductId]) {
        const res = await request(app).get(`/api/v1/products/${id}`).set(as(tokenA));
        expect(res.statusCode).toEqual(404);
      }
      const list = await request(app).get(`/api/v1/products?search=${tag}`).set(as(tokenA));
      const names = (list.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(names).toContain(productId);
      expect(names).not.toContain(inactiveProductId);
      expect(names).not.toContain(hiddenCategoryProductId);
    });

    it('the super admin can still open them', async () => {
      for (const id of [inactiveProductId, hiddenCategoryProductId]) {
        expect((await request(app).get(`/api/v1/products/${id}`).set(as(adminToken))).statusCode).toEqual(200);
      }
    });

    it("can't add hidden products to the cart or order them", async () => {
      for (const id of [inactiveProductId, hiddenCategoryProductId]) {
        const cart = await request(app).post('/api/v1/cart/items').set(as(tokenA)).send({ productId: id, quantity: 1 });
        expect(cart.body.errorCode).toEqual('PRODUCT_UNAVAILABLE');
        const order = await pickupOrder(tokenA, [{ productId: id, quantity: 1 }]);
        expect(order.statusCode).toEqual(400);
        expect(order.body.errorCode).toEqual('PRODUCT_UNAVAILABLE');
      }
    });
  });

  describe('checkout (E)', () => {
    it('ignores prices, fees and totals sent by the app', async () => {
      const res = await pickupOrder(
        tokenA,
        [{ productId, quantity: 2, price: 1, unitPrice: 1, totalPrice: 1 }],
        { total: 1, subtotal: 1, deliveryFee: 0, codCharge: 0, discount: 999, paymentStatus: 'PAID', orderStatus: 'DELIVERED' },
      );
      expect(res.statusCode).toEqual(201);
      expect(res.body.data.order).toMatchObject({ subtotal: 100, total: 100, paymentStatus: 'PENDING', orderStatus: 'PLACED' });

      const stored = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.order.id }, include: { items: true } });
      expect(Number(stored.total)).toEqual(100);
      expect(Number(stored.discount)).toEqual(0);
      expect(Number(stored.items[0].unitPrice)).toEqual(50);
    });

    it('refuses the same product twice in one order (max-quantity rule bypass)', async () => {
      const before = await stock();
      const res = await pickupOrder(tokenA, [
        { productId, quantity: 5 },
        { productId, quantity: 5 },
      ]);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('DUPLICATE_ORDER_ITEM');
      expect(await stock()).toEqual(before);
    });

    it(`refuses more than ${MAX_ORDER_LINES} lines`, async () => {
      const items = Array.from({ length: MAX_ORDER_LINES + 1 }, (_, i) => ({
        productId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        quantity: 1,
      }));
      const res = await pickupOrder(tokenA, items);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('TOO_MANY_ITEMS');
    });

    it.each([
      [6, 'above the maximum'],
      [0.3, 'not a multiple of the step'],
      [0, 'zero'],
      [-1, 'negative'],
    ])('refuses quantity %p (%s)', async (quantity) => {
      const before = await stock();
      const res = await pickupOrder(tokenA, [{ productId, quantity }]);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('INVALID_QUANTITY');
      expect(await stock()).toEqual(before);
    });

    it("can't deliver to another customer's address", async () => {
      const address = await prisma.userAddress.create({
        data: { userId: userB, title: 'Home', addressLine: '1 Road', city: 'Rajkot', state: 'Gujarat', pincode: '360005', latitude: 22.308155, longitude: 70.800705 },
      });
      const res = await request(app)
        .post('/api/v1/orders')
        .set(as(tokenA))
        .send({ fulfillmentType: 'DELIVERY', addressId: address.id, paymentMethod: 'COD', items: [{ productId, quantity: 5 }] });
      expect(res.statusCode).toEqual(404);
      expect(res.body.errorCode).toEqual('ADDRESS_NOT_FOUND');
    });

    it("can't pick up from an inactive store", async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set(as(tokenA))
        .send({ fulfillmentType: 'PICKUP', storeId: inactiveStoreId, paymentMethod: 'COD', items: [{ productId, quantity: 1 }] });
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toEqual('STORE_UNAVAILABLE');
    });

    it("can't change or remove another customer's cart item", async () => {
      const added = await request(app).post('/api/v1/cart/items').set(as(tokenB)).send({ productId, quantity: 1 });
      expect(added.statusCode).toEqual(201);
      const itemId = added.body.data.id;

      const update = await request(app).put(`/api/v1/cart/items/${itemId}`).set(as(tokenA)).send({ quantity: 5 });
      const remove = await request(app).delete(`/api/v1/cart/items/${itemId}`).set(as(tokenA));
      expect(update.statusCode).toEqual(404);
      expect(remove.statusCode).toEqual(404);

      const stored = await prisma.cartItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(Number(stored.quantity)).toEqual(1);
      expect(stored.userId).toEqual(userB);
    });
  });

  describe('orders (F)', () => {
    it("can't open another customer's order, and lists only own orders", async () => {
      const mine = await pickupOrder(tokenB, [{ productId, quantity: 1 }]);
      expect(mine.statusCode).toEqual(201);
      const orderId = mine.body.data.order.id;

      const peek = await request(app).get(`/api/v1/orders/${orderId}`).set(as(tokenA));
      expect(peek.statusCode).toEqual(404);
      expect(peek.body.errorCode).toEqual('ORDER_NOT_FOUND');

      const list = await request(app).get('/api/v1/orders').set(as(tokenA));
      expect(list.statusCode).toEqual(200);
      const ids = (list.body.data as Array<{ id: string }>).map((o) => o.id);
      expect(ids).not.toContain(orderId);
    });
  });
});
