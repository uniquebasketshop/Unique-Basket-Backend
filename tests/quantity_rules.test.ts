import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { validateQuantityForUnit } from '../src/utils/quantity';

// P1-04 / D-007: PIECE quantities must be whole numbers; precision limited to the DB column (3 decimals).
describe('Quantity rules (P1-04)', () => {
  describe('validateQuantityForUnit', () => {
    it('accepts whole PIECE quantities and decimal KG quantities', () => {
      expect(validateQuantityForUnit('PIECE', 3)).toBeNull();
      expect(validateQuantityForUnit('KG', 0.5)).toBeNull();
      expect(validateQuantityForUnit('KG', 1.255)).toBeNull();
      expect(validateQuantityForUnit('GRAM', 250)).toBeNull();
    });

    it('rejects fractional PIECE quantities', () => {
      expect(validateQuantityForUnit('PIECE', 1.5)).toMatch(/whole number/);
      expect(validateQuantityForUnit('PIECE', 0.1)).toMatch(/whole number/);
    });

    it('rejects non-positive, non-finite, over-precise and oversized quantities', () => {
      expect(validateQuantityForUnit('KG', 0)).toMatch(/positive/);
      expect(validateQuantityForUnit('KG', -1)).toMatch(/positive/);
      expect(validateQuantityForUnit('KG', NaN)).toMatch(/positive/);
      expect(validateQuantityForUnit('KG', Infinity)).toMatch(/positive/);
      expect(validateQuantityForUnit('KG', 1.2345)).toMatch(/decimal places/);
      expect(validateQuantityForUnit('KG', 0.0000001)).toMatch(/decimal places/);
      expect(validateQuantityForUnit('KG', 10000000)).toMatch(/cannot exceed/);
    });
  });

  describe('API enforcement', () => {
    const customerPhone = '+919888800104';
    let customerId: string;
    let storeId: string;
    let pieceProductId: string;
    let kgProductId: string;
    let customerToken: string;

    beforeAll(async () => {
      const store = await prisma.store.findUnique({ where: { storeId: 'STORE-001' } });
      const category = await prisma.category.findFirst({ where: { isActive: true } });
      if (!store || !category) throw new Error('Seed data not found.');
      storeId = store.id;

      const piece = await prisma.product.create({
        data: { name: 'P104 Coconut', categoryId: category.id, unit: 'PIECE', price: 40 },
      });
      const kg = await prisma.product.create({
        data: { name: 'P104 Grapes', categoryId: category.id, unit: 'KG', price: 120 },
      });
      pieceProductId = piece.id;
      kgProductId = kg.id;
      await prisma.storeInventory.createMany({
        data: [
          { storeId, productId: pieceProductId, stockQuantity: 100 },
          { storeId, productId: kgProductId, stockQuantity: 100 },
        ],
      });

      const user = await prisma.user.upsert({
        where: { phone: customerPhone },
        update: {},
        create: { phone: customerPhone, name: 'Quantity Rules Customer' },
      });
      customerId = user.id;
      customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
    });

    afterAll(async () => {
      await prisma.order.deleteMany({ where: { userId: customerId } });
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
      await prisma.inventoryTransaction.deleteMany({ where: { productId: { in: [pieceProductId, kgProductId] } } });
      await prisma.storeInventory.deleteMany({ where: { productId: { in: [pieceProductId, kgProductId] } } });
      await prisma.product.deleteMany({ where: { id: { in: [pieceProductId, kgProductId] } } });
      await prisma.user.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    const addToCart = (productId: string, quantity: unknown) =>
      request(app)
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ productId, quantity });

    it('rejects adding a fractional PIECE quantity to the cart', async () => {
      const res = await addToCart(pieceProductId, 1.5);
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_QUANTITY');
    });

    it('accepts whole PIECE and decimal KG quantities in the cart', async () => {
      expect((await addToCart(pieceProductId, 2)).statusCode).toEqual(201);
      expect((await addToCart(kgProductId, 1.25)).statusCode).toEqual(201);
    });

    it('rejects updating a PIECE cart item to a fractional quantity', async () => {
      const item = await prisma.cartItem.findUniqueOrThrow({
        where: { userId_productId: { userId: customerId, productId: pieceProductId } },
      });
      const res = await request(app)
        .put(`/api/v1/cart/items/${item.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ quantity: 2.5 });
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_QUANTITY');
      const after = await prisma.cartItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(Number(after.quantity)).toEqual(2);
    });

    it('rejects over-precise KG quantities in the cart', async () => {
      const res = await addToCart(kgProductId, 1.2345);
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_QUANTITY');
    });

    it('rejects a checkout with a fractional PIECE quantity and leaves stock untouched', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId,
          paymentMethod: 'COD',
          items: [{ productId: pieceProductId, quantity: 3.5 }],
        });
      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_QUANTITY');
      const inv = await prisma.storeInventory.findUniqueOrThrow({
        where: { storeId_productId: { storeId, productId: pieceProductId } },
      });
      expect(Number(inv.stockQuantity)).toEqual(100);
    });

    it('accepts a checkout with whole PIECE and decimal KG quantities', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          fulfillmentType: 'PICKUP',
          storeId,
          paymentMethod: 'COD',
          items: [
            { productId: pieceProductId, quantity: 3 },
            { productId: kgProductId, quantity: 0.75 },
          ],
        });
      expect(res.statusCode).toEqual(201);
    });
  });
});
