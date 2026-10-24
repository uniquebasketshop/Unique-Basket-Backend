import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { resetRateLimits } from '../src/middlewares/rateLimit';

// P1-11: auth endpoints are rate limited (enabled explicitly for this suite).
describe('Auth rate limiting (P1-11)', () => {
  beforeAll(() => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
  });

  beforeEach(() => resetRateLimits());

  afterAll(async () => {
    delete process.env.RATE_LIMIT_IN_TESTS;
    resetRateLimits();
    await prisma.user.deleteMany({ where: { phone: { startsWith: '+9190011' } } });
    await prisma.$disconnect();
  });

  it('limits admin login attempts per email (10 / 15 min) with 429 RATE_LIMITED', async () => {
    const attempt = () =>
      request(app).post('/api/v1/admin/login').send({ email: 'Victim@UniqueBasket.com', password: 'wrong' });

    for (let i = 0; i < 10; i++) {
      expect((await attempt()).statusCode).toEqual(401);
    }
    const blocked = await attempt();
    expect(blocked.statusCode).toEqual(429);
    expect(blocked.body).toHaveProperty('errorCode', 'RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // A different account from the same client is still allowed (per-email counter)
    const other = await request(app).post('/api/v1/admin/login').send({ email: 'someone@else.com', password: 'wrong' });
    expect(other.statusCode).toEqual(401);
  });

  it('limits admin login attempts per IP across emails (20 / 15 min)', async () => {
    for (let i = 0; i < 20; i++) {
      await request(app).post('/api/v1/admin/login').send({ email: `user${i}@x.com`, password: 'wrong' });
    }
    const blocked = await request(app).post('/api/v1/admin/login').send({ email: 'fresh@x.com', password: 'wrong' });
    expect(blocked.statusCode).toEqual(429);
  });

  it('limits OTP requests per IP across phone numbers (20 / 15 min)', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app).post('/api/v1/auth/send-otp').send({ phone: `+9190011${String(i).padStart(5, '0')}` });
      expect(res.statusCode).toEqual(200);
    }
    const blocked = await request(app).post('/api/v1/auth/send-otp').send({ phone: '+919001199999' });
    expect(blocked.statusCode).toEqual(429);
  });

  it('limits refresh attempts per IP (60 / 15 min)', async () => {
    for (let i = 0; i < 60; i++) {
      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'garbage' });
    }
    const blocked = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'garbage' });
    expect(blocked.statusCode).toEqual(429);
  });

  it('is disabled under NODE_ENV=test unless explicitly enabled', async () => {
    delete process.env.RATE_LIMIT_IN_TESTS;
    for (let i = 0; i < 15; i++) {
      expect((await request(app).post('/api/v1/admin/login').send({ email: 'a@b.com', password: 'x' })).statusCode).toEqual(401);
    }
    process.env.RATE_LIMIT_IN_TESTS = 'true';
  });
});
