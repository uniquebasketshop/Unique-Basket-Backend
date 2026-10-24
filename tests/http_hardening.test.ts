import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';

// P3-03: CORS allow-list, security headers, body limit.
describe('HTTP hardening (P3-03)', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, CORS_ORIGINS: process.env.CORS_ORIGINS };

  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.CORS_ORIGINS === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = saved.CORS_ORIGINS;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const preflight = (origin: string) =>
    request(app).options('/api/v1/auth/send-otp').set('Origin', origin).set('Access-Control-Request-Method', 'POST');

  it('allows only configured origins when CORS_ORIGINS is set', async () => {
    process.env.CORS_ORIGINS = 'https://admin.example.com, https://ops.example.com/';

    const ok = await preflight('https://admin.example.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://admin.example.com');

    const trailing = await preflight('https://ops.example.com');
    expect(trailing.headers['access-control-allow-origin']).toBe('https://ops.example.com');

    const evil = await preflight('https://evil.example.com');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows any origin in development/test when CORS_ORIGINS is not set', async () => {
    delete process.env.CORS_ORIGINS;
    const res = await preflight('http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('allows no browser origin in production when CORS_ORIGINS is not set', async () => {
    delete process.env.CORS_ORIGINS;
    process.env.NODE_ENV = 'production';
    const res = await preflight('https://anything.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still serves requests without an Origin header (mobile app)', async () => {
    process.env.CORS_ORIGINS = 'https://admin.example.com';
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
  });

  it('sets security headers and hides X-Powered-By', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects oversized JSON bodies with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/auth/send-otp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ phone: '+919999999999', padding: 'x'.repeat(200 * 1024) }));
    expect(res.statusCode).toEqual(413);
    expect(res.body).toHaveProperty('errorCode', 'PAYLOAD_TOO_LARGE');
  });
});
