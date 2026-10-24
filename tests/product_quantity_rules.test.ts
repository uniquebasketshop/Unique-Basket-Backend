import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { parseQuantityConfig, validateProductQuantity, validateQuantityRule } from '../src/utils/quantity';

// D-012: quantity rules are product-level and admin-configurable.
describe('Product-level quantity rules (D-012)', () => {
  const potato = { unit: 'KG' as const, minQuantity: 1, maxQuantity: 10, quantityStep: 0.25 };
  const apple = { unit: 'KG' as const, minQuantity: 0.5, maxQuantity: 5, quantityStep: 0.25 };
  const berries = { unit: 'GRAM' as const, minQuantity: 250, maxQuantity: 2000, quantityStep: 250 };
  const cherries = { unit: 'GRAM' as const, minQuantity: 100, maxQuantity: 1000, quantityStep: 50 };
  const coconut = { unit: 'PIECE' as const, minQuantity: 1, maxQuantity: 10, quantityStep: 1 };

  describe('validateProductQuantity', () => {
    it('KG product with a 1 KG minimum', () => {
      expect(validateProductQuantity(potato, 1)).toBeNull();
      expect(validateProductQuantity(potato, 0.75)).toMatch(/Minimum quantity is 1 KG/);
    });

    it('KG product with a 0.5 KG minimum and 0.25 KG step', () => {
      expect(validateProductQuantity(apple, 0.5)).toBeNull();
      expect(validateProductQuantity(apple, 0.75)).toBeNull();
      expect(validateProductQuantity(apple, 0.25)).toMatch(/Minimum/);
    });

    it('KG step validation', () => {
      expect(validateProductQuantity(potato, 1.25)).toBeNull();
      expect(validateProductQuantity(potato, 1.3)).toMatch(/multiples of 0.25 KG/);
      expect(validateProductQuantity(potato, 1.125)).toMatch(/multiples/);
    });

    it('KG maximum validation (boundary accepted, above rejected)', () => {
      expect(validateProductQuantity(potato, 10)).toBeNull();
      expect(validateProductQuantity(potato, 10.25)).toMatch(/Maximum quantity is 10 KG/);
    });

    it('GRAM product with a 250 G step', () => {
      expect(validateProductQuantity(berries, 250)).toBeNull();
      expect(validateProductQuantity(berries, 750)).toBeNull();
      expect(validateProductQuantity(berries, 2000)).toBeNull();
      expect(validateProductQuantity(berries, 300)).toMatch(/multiples of 250 GRAM/);
      expect(validateProductQuantity(berries, 2250)).toMatch(/Maximum/);
      expect(validateProductQuantity(berries, 249)).toMatch(/Minimum/);
    });

    it('GRAM product with a different configured minimum', () => {
      expect(validateProductQuantity(cherries, 100)).toBeNull();
      expect(validateProductQuantity(cherries, 150)).toBeNull();
      expect(validateProductQuantity(cherries, 50)).toMatch(/Minimum quantity is 100 GRAM/);
      expect(validateProductQuantity(cherries, 250.5)).toMatch(/whole number/);
    });

    it('PIECE product only accepts whole numbers', () => {
      expect(validateProductQuantity(coconut, 3)).toBeNull();
      expect(validateProductQuantity(coconut, 1.5)).toMatch(/whole number/);
      expect(validateProductQuantity(coconut, 11)).toMatch(/Maximum/);
    });

    it('PACK and DOZEN products only accept whole numbers, configured or not', () => {
      const pack = { unit: 'PACK' as const, minQuantity: 1, maxQuantity: 6, quantityStep: 1 };
      expect(validateProductQuantity(pack, 2)).toBeNull();
      expect(validateProductQuantity(pack, 1.5)).toMatch(/whole number/);
      const dozen = { unit: 'DOZEN' as const, minQuantity: null, maxQuantity: null, quantityStep: null };
      expect(validateProductQuantity(dozen, 3)).toBeNull();
      expect(validateProductQuantity(dozen, 0.5)).toMatch(/whole number/);
    });

    it('falls back to unit rules when a product has no configuration', () => {
      const legacy = { unit: 'KG' as const, minQuantity: null, maxQuantity: null, quantityStep: null };
      expect(validateProductQuantity(legacy, 0.3)).toBeNull();
      expect(validateProductQuantity(legacy, 1.2345)).toMatch(/decimal places/);
    });
  });

  describe('validateQuantityRule (admin configuration)', () => {
    it('accepts the example configurations', () => {
      expect(validateQuantityRule('KG', { min: 1, max: 10, step: 0.25 })).toBeNull();
      expect(validateQuantityRule('KG', { min: 0.5, max: 5, step: 0.25 })).toBeNull();
      expect(validateQuantityRule('GRAM', { min: 250, max: 2000, step: 250 })).toBeNull();
      expect(validateQuantityRule('PIECE', { min: 1, max: 10, step: 1 })).toBeNull();
      expect(validateQuantityRule('PIECE', { min: 2, max: 2, step: 1 })).toBeNull();
    });

    it.each([
      ['KG', { min: 0, max: 10, step: 0.25 }, /Minimum quantity must be greater than 0/],
      ['KG', { min: 1, max: 10, step: 0 }, /Quantity step must be greater than 0/],
      ['KG', { min: 5, max: 2, step: 0.5 }, /greater than or equal to the minimum/],
      ['KG', { min: 1, max: 1.5, step: 1 }, /step cannot be larger than the range/],
      ['KG', { min: 1, max: 10, step: 0.4 }, /reachable from the minimum/],
      ['KG', { min: 0.0001, max: 1, step: 0.25 }, /decimal places/],
      ['GRAM', { min: 250.5, max: 2000, step: 250 }, /whole number/],
      ['PIECE', { min: 1, max: 10, step: 0.5 }, /whole number/],
      ['PIECE', { min: 1.5, max: 10, step: 1 }, /whole number/],
      ['PACK', { min: 1, max: 5, step: 0.5 }, /whole number/],
      ['DOZEN', { min: 0.5, max: 4, step: 1 }, /whole number/],
    ] as const)('rejects invalid %s configuration %j', (unit, rule, message) => {
      expect(validateQuantityRule(unit, rule)).toMatch(message);
    });

    it('requires all three fields together, and allows clearing them', () => {
      expect(parseQuantityConfig({}, 'KG')).toEqual({});
      expect(parseQuantityConfig({ minQuantity: 1 }, 'KG').error).toMatch(/together/);
      expect(parseQuantityConfig({ minQuantity: 1, maxQuantity: 10, quantityStep: '' }, 'KG').error).toMatch(/together/);
      expect(parseQuantityConfig({ minQuantity: null, maxQuantity: null, quantityStep: null }, 'KG').data).toEqual({
        minQuantity: null,
        maxQuantity: null,
        quantityStep: null,
      });
      expect(parseQuantityConfig({ minQuantity: '1', maxQuantity: '10', quantityStep: '0.25' }, 'KG').data).toEqual({
        minQuantity: 1,
        maxQuantity: 10,
        quantityStep: 0.25,
      });
      expect(parseQuantityConfig({ minQuantity: 'abc', maxQuantity: 10, quantityStep: 1 }, 'KG').error).toMatch(/greater than 0/);
    });
  });

  describe('API', () => {
    const customerPhone = '+919888800812';
    let superToken: string;
    let customerToken: string;
    let customerId: string;
    let storeId: string;
    let categoryId: string;
    const productIds: string[] = [];

    beforeAll(async () => {
      const superAdmin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
      superToken = generateAccessToken({ id: superAdmin.id, role: 'SUPER_ADMIN', email: superAdmin.email });
      const store = await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } });
      storeId = store.id;
      categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true } })).id;
      const user = await prisma.user.upsert({
        where: { phone: customerPhone },
        update: {},
        create: { phone: customerPhone, name: 'Quantity Config Customer' },
      });
      customerId = user.id;
      customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
    });

    afterAll(async () => {
      await prisma.order.deleteMany({ where: { userId: customerId } });
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
      await prisma.inventoryTransaction.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.storeInventory.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      await prisma.user.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    const admin = () => ({ Authorization: `Bearer ${superToken}` });
    const customer = () => ({ Authorization: `Bearer ${customerToken}` });

    const createProduct = async (body: Record<string, unknown>) => {
      const res = await request(app).post('/api/v1/products').set(admin()).send({ categoryId, price: 1, ...body }); // low price keeps orders inside COD limits
      if (res.statusCode === 201) {
        productIds.push(res.body.data.id);
        await prisma.storeInventory.create({ data: { storeId, productId: res.body.data.id, stockQuantity: 5000 } });
      }
      return res;
    };

    let potatoId: string;
    let berriesId: string;
    let coconutId: string;

    it('lets an admin create products with quantity configuration', async () => {
      const potatoRes = await createProduct({ name: 'D012 Potato', unit: 'KG', minQuantity: 1, maxQuantity: 10, quantityStep: 0.25 });
      expect(potatoRes.statusCode).toEqual(201);
      expect(Number(potatoRes.body.data.minQuantity)).toBe(1);
      expect(Number(potatoRes.body.data.maxQuantity)).toBe(10);
      expect(Number(potatoRes.body.data.quantityStep)).toBe(0.25);
      potatoId = potatoRes.body.data.id;

      berriesId = (await createProduct({ name: 'D012 Berries', unit: 'GRAM', minQuantity: 250, maxQuantity: 2000, quantityStep: 250 })).body.data.id;
      coconutId = (await createProduct({ name: 'D012 Coconut', unit: 'PIECE', minQuantity: 1, maxQuantity: 10, quantityStep: 1 })).body.data.id;
      expect(berriesId).toBeDefined();
      expect(coconutId).toBeDefined();
    });

    it('rejects invalid configurations on create with INVALID_QUANTITY_CONFIG', async () => {
      for (const body of [
        { unit: 'KG', minQuantity: 0, maxQuantity: 10, quantityStep: 0.25 },
        { unit: 'KG', minQuantity: 5, maxQuantity: 1, quantityStep: 0.25 },
        { unit: 'PIECE', minQuantity: 1, maxQuantity: 10, quantityStep: 0.5 },
        { unit: 'KG', minQuantity: 1, maxQuantity: 10 },
      ]) {
        const res = await createProduct({ name: 'D012 Invalid', ...body });
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toBe('INVALID_QUANTITY_CONFIG');
      }
    });

    it('lets an admin update and clear quantity configuration, with an audit entry', async () => {
      const res = await request(app)
        .put(`/api/v1/products/${potatoId}`)
        .set(admin())
        .send({ minQuantity: '2', maxQuantity: '8', quantityStep: '0.5' });
      expect(res.statusCode).toEqual(200);
      expect(Number(res.body.data.minQuantity)).toBe(2);
      expect(await prisma.auditLog.count({ where: { action: 'PRODUCT_QUANTITY_RULES_CHANGED', details: { contains: 'D012 Potato' } } })).toBeGreaterThan(0);

      const invalid = await request(app).put(`/api/v1/products/${potatoId}`).set(admin()).send({ minQuantity: 2, maxQuantity: 8, quantityStep: 0.35 });
      expect(invalid.statusCode).toEqual(400);
      expect(invalid.body.errorCode).toBe('INVALID_QUANTITY_CONFIG');

      // Restore the potato example
      await request(app).put(`/api/v1/products/${potatoId}`).set(admin()).send({ minQuantity: 1, maxQuantity: 10, quantityStep: 0.25 });

      const temp = await createProduct({ name: 'D012 Temp', unit: 'KG', minQuantity: 1, maxQuantity: 2, quantityStep: 0.5 });
      const cleared = await request(app)
        .put(`/api/v1/products/${temp.body.data.id}`)
        .set(admin())
        .send({ minQuantity: null, maxQuantity: null, quantityStep: null });
      expect(cleared.statusCode).toEqual(200);
      expect(cleared.body.data.minQuantity).toBeNull();

      // Saving an unconfigured product again (admin form sends nulls) writes no rules-changed audit entry
      const auditBefore = await prisma.auditLog.count({ where: { action: 'PRODUCT_QUANTITY_RULES_CHANGED', details: { contains: 'D012 Temp' } } });
      await request(app)
        .put(`/api/v1/products/${temp.body.data.id}`)
        .set(admin())
        .send({ name: 'D012 Temp', minQuantity: null, maxQuantity: null, quantityStep: null });
      expect(await prisma.auditLog.count({ where: { action: 'PRODUCT_QUANTITY_RULES_CHANGED', details: { contains: 'D012 Temp' } } })).toBe(auditBefore);
    });

    it('rejects a unit change that makes the existing configuration invalid', async () => {
      const res = await request(app).put(`/api/v1/products/${potatoId}`).set(admin()).send({ unit: 'PIECE' });
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('INVALID_QUANTITY_CONFIG');
    });

    it('exposes the configuration on the customer store catalogue and the cart', async () => {
      const res = await request(app).get(`/api/v1/products/store/${storeId}`).set(customer());
      const listed = res.body.data.find((p: { id: string }) => p.id === potatoId);
      expect(Number(listed.minQuantity)).toBe(1);
      expect(Number(listed.maxQuantity)).toBe(10);
      expect(Number(listed.quantityStep)).toBe(0.25);

      await prisma.cartItem.create({ data: { userId: customerId, productId: berriesId, quantity: 500 } });
      const cart = await request(app).get('/api/v1/cart').set(customer());
      const line = cart.body.data.items.find((i: { productId: string }) => i.productId === berriesId);
      expect(line).toMatchObject({ minQuantity: 250, maxQuantity: 2000, quantityStep: 250, quantity: 500 });
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
    });

    const addToCart = (productId: string, quantity: unknown) =>
      request(app).post('/api/v1/cart/items').set(customer()).send({ productId, quantity });

    it.each([
      ['below minimum', () => potatoId, 0.75],
      ['above maximum', () => potatoId, 10.25],
      ['off step', () => potatoId, 1.1],
      ['GRAM off step', () => berriesId, 300],
      ['fractional PIECE', () => coconutId, 2.5],
    ])('cart add rejects a quantity %s even if the client bypasses the UI', async (_label, id, qty) => {
      const res = await addToCart(id(), qty);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('INVALID_QUANTITY');
    });

    it('cart add accepts boundary quantities', async () => {
      expect((await addToCart(potatoId, 1)).statusCode).toEqual(201);
      expect((await addToCart(potatoId, 10)).statusCode).toEqual(201);
      expect((await addToCart(berriesId, 2000)).statusCode).toEqual(201);
      expect((await addToCart(coconutId, 10)).statusCode).toEqual(201);
    });

    it('cart update rejects quantities that break the rules and keeps the old quantity', async () => {
      const item = await prisma.cartItem.findUniqueOrThrow({ where: { userId_productId: { userId: customerId, productId: potatoId } } });
      for (const quantity of [0.5, 10.5, 2.1]) {
        const res = await request(app).put(`/api/v1/cart/items/${item.id}`).set(customer()).send({ quantity });
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toBe('INVALID_QUANTITY');
      }
      const ok = await request(app).put(`/api/v1/cart/items/${item.id}`).set(customer()).send({ quantity: 2.75 });
      expect(ok.statusCode).toEqual(200);
      expect(Number((await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } })).quantity)).toBe(2.75);
    });

    const placeOrder = (items: { productId: string; quantity: number }[]) =>
      request(app).post('/api/v1/orders').set(customer()).send({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items });

    it('order creation rejects quantities outside the configuration and leaves stock untouched', async () => {
      for (const items of [
        [{ productId: potatoId, quantity: 0.5 }],
        [{ productId: potatoId, quantity: 11 }],
        [{ productId: potatoId, quantity: 1.3 }],
        [{ productId: berriesId, quantity: 100 }],
        [{ productId: coconutId, quantity: 1.5 }],
      ]) {
        const res = await placeOrder(items);
        expect(res.statusCode).toEqual(400);
        expect(res.body.errorCode).toBe('INVALID_QUANTITY');
      }
      const inv = await prisma.storeInventory.findUniqueOrThrow({ where: { storeId_productId: { storeId, productId: potatoId } } });
      expect(Number(inv.stockQuantity)).toBe(5000);
    });

    it('order creation accepts valid boundary quantities', async () => {
      const res = await placeOrder([
        { productId: potatoId, quantity: 10 },
        { productId: berriesId, quantity: 250 },
        { productId: coconutId, quantity: 1 },
      ]);
      expect(res.statusCode).toEqual(201);
    });
  });
});
