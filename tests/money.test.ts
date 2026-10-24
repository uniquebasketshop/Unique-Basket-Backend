import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { fromPaise, lineTotalPaise, toPaise } from '../src/utils/money';

// P2-03: exact money arithmetic.
describe('Money arithmetic (P2-03)', () => {
  it('rounds half-up exactly where float toFixed fails', () => {
    // 0.5 × 2.01 = 1.005 → 1.01 (JS: (1.005).toFixed(2) === "1.00")
    expect((0.5 * 2.01).toFixed(2)).toBe('1.00');
    expect(fromPaise(lineTotalPaise(0.5, 2.01))).toBe(1.01);
    expect(fromPaise(lineTotalPaise('0.333', '19.99'))).toBe(6.66);
    expect(toPaise(1.15)).toBe(115);
    expect(toPaise(new Prisma.Decimal('49.99'))).toBe(4999);
  });

  it('matches exact decimal arithmetic for random carts', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let cart = 0; cart < 200; cart++) {
      let exact = new Prisma.Decimal(0);
      let paise = 0;
      const lines = 1 + Math.floor(rand() * 15);
      for (let i = 0; i < lines; i++) {
        const qty = new Prisma.Decimal((Math.floor(rand() * 20000) + 1) / 1000); // up to 3 decimals
        const price = new Prisma.Decimal((Math.floor(rand() * 100000) + 1) / 100); // up to 2 decimals
        exact = exact.plus(qty.times(price).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP));
        paise += lineTotalPaise(qty, price);
      }
      expect(fromPaise(paise)).toBe(exact.toNumber());
    }
  });

  it('does not overflow for very large quantity × price', () => {
    expect(lineTotalPaise(9999999.999, 99999999.99)).toBe(Number(
      new Prisma.Decimal('9999999.999').times('99999999.99').times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    ));
  });

  describe('API', () => {
    const phone = '+919888800203';
    let customerId: string;
    let productId: string;

    beforeAll(async () => {
      const category = await prisma.category.findFirstOrThrow({ where: { isActive: true } });
      const product = await prisma.product.create({
        data: { name: 'P203 Saffron', categoryId: category.id, unit: 'KG', price: 2.01 },
      });
      productId = product.id;
      const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Money Customer' } });
      customerId = user.id;
      await prisma.cartItem.create({ data: { userId: customerId, productId, quantity: 0.5 } });
    });

    afterAll(async () => {
      await prisma.cartItem.deleteMany({ where: { userId: customerId } });
      await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.user.deleteMany({ where: { id: customerId } });
      await prisma.$disconnect();
    });

    it('cart line and subtotal use exact half-up rounding', async () => {
      const token = generateAccessToken({ id: customerId, role: 'customer', phone });
      const res = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.items[0].totalPrice).toBe(1.01);
      expect(res.body.data.subtotal).toBe(1.01);
    });
  });
});
