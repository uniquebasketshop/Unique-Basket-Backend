import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';

// P3-04: DB-aware health check and structured request logging.
describe('Health and request logging (P3-04)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LOG_REQUESTS;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reports database up', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toMatchObject({ success: true, database: 'up' });
  });

  it('returns 503 when the database is unreachable', async () => {
    jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(503);
    expect(res.body).toMatchObject({ success: false, database: 'down' });
  });

  it('logs method, path without query string, status and duration (no bodies)', async () => {
    process.env.LOG_REQUESTS = 'true';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await request(app).post('/api/v1/auth/send-otp?debug=secret').send({ phone: 'not-a-phone' });

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('http_request'));
    expect(line).toBeDefined();
    expect(line).toContain('"method":"POST"');
    expect(line).toContain('"path":"/api/v1/auth/send-otp"');
    expect(line).toContain('"status":400');
    expect(line).toContain('"durationMs"');
    expect(line).not.toContain('debug=secret');
    expect(line).not.toContain('not-a-phone');
  });
});
