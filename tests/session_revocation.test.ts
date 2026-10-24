import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateRefreshToken } from '../src/utils/jwt';

// P1-08: refresh tokens are backed by revocable server-side sessions.
describe('Refresh token sessions and logout (P1-08)', () => {
  const phoneA = '+919888800108';
  const phoneB = '+919888800208';

  const login = async (phone: string) => {
    await request(app).post('/api/v1/auth/send-otp').send({ phone });
    const res = await request(app).post('/api/v1/auth/verify-otp').send({ phone, otp: '1234' });
    expect(res.statusCode).toEqual(200);
    return res.body.data as { token: string; refreshToken: string; user: { id: string } };
  };

  const refresh = (refreshToken: string) =>
    request(app).post('/api/v1/auth/refresh').send({ refreshToken });

  const logout = (body: Record<string, unknown>) => request(app).post('/api/v1/auth/logout').send(body);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone: { in: [phoneA, phoneB] } } });
    await prisma.$disconnect();
  });

  it('issues a refresh token that can be used to get a new access token', async () => {
    const session = await login(phoneA);
    const res = await refresh(session.refreshToken);
    expect(res.statusCode).toEqual(200);
    expect(typeof res.body.data.token).toBe('string');
  });

  it('revokes only the logged-out session', async () => {
    const first = await login(phoneA);
    const second = await login(phoneA);

    expect((await logout({ refreshToken: first.refreshToken })).statusCode).toEqual(200);

    const revoked = await refresh(first.refreshToken);
    expect(revoked.statusCode).toEqual(401);
    expect(revoked.body).toHaveProperty('errorCode', 'INVALID_REFRESH_TOKEN');

    expect((await refresh(second.refreshToken)).statusCode).toEqual(200);
  });

  it('keeps logout idempotent for already-revoked or garbage tokens', async () => {
    const session = await login(phoneA);
    expect((await logout({ refreshToken: session.refreshToken })).statusCode).toEqual(200);
    expect((await logout({ refreshToken: session.refreshToken })).statusCode).toEqual(200);
    expect((await logout({ refreshToken: 'not-a-jwt' })).statusCode).toEqual(200);
    expect((await logout({})).statusCode).toEqual(200);
  });

  it('rejects refresh for a deactivated customer and revokes the session', async () => {
    const session = await login(phoneB);
    await prisma.user.update({ where: { id: session.user.id }, data: { isActive: false } });

    const res = await refresh(session.refreshToken);
    expect(res.statusCode).toEqual(401);
    expect(res.body).toHaveProperty('errorCode', 'ACCOUNT_DEACTIVATED');

    await prisma.user.update({ where: { id: session.user.id }, data: { isActive: true } });
    // Session stays revoked even after reactivation
    expect((await refresh(session.refreshToken)).statusCode).toEqual(401);
  });

  it('rejects legacy refresh tokens that are not linked to a session', async () => {
    const session = await login(phoneA);
    const legacy = generateRefreshToken({ id: session.user.id, role: 'customer' });
    const res = await refresh(legacy);
    expect(res.statusCode).toEqual(401);
    expect(res.body).toHaveProperty('errorCode', 'INVALID_REFRESH_TOKEN');
  });

  it('rejects an expired session even if the JWT itself is still valid', async () => {
    const session = await login(phoneA);
    const sessionId = JSON.parse(Buffer.from(session.refreshToken.split('.')[1], 'base64url').toString()).jti;
    await prisma.refreshToken.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await refresh(session.refreshToken)).statusCode).toEqual(401);
  });

  it('rejects a refresh token whose session belongs to a different user', async () => {
    const a = await login(phoneA);
    const b = await login(phoneB);
    const sessionOfB = JSON.parse(Buffer.from(b.refreshToken.split('.')[1], 'base64url').toString()).jti;
    const forged = generateRefreshToken({ id: a.user.id, role: 'customer' }, sessionOfB);

    expect((await refresh(forged)).statusCode).toEqual(401);
  });

  it('only deletes device tokens owned by the logging-out user', async () => {
    const a = await login(phoneA);
    const b = await login(phoneB);
    await prisma.deviceToken.createMany({
      data: [
        { token: 'p108-device-a', platform: 'ANDROID', userId: a.user.id },
        { token: 'p108-device-b', platform: 'ANDROID', userId: b.user.id },
      ],
    });

    // A tries to remove B's device token
    await logout({ refreshToken: a.refreshToken, deviceToken: 'p108-device-b' });
    expect(await prisma.deviceToken.count({ where: { token: 'p108-device-b' } })).toEqual(1);

    // Unauthenticated logout cannot remove anyone's device token
    await logout({ deviceToken: 'p108-device-b' });
    expect(await prisma.deviceToken.count({ where: { token: 'p108-device-b' } })).toEqual(1);

    // B removes their own
    await logout({ refreshToken: b.refreshToken, deviceToken: 'p108-device-b' });
    expect(await prisma.deviceToken.count({ where: { token: 'p108-device-b' } })).toEqual(0);
  });

  it('applies to admin sessions too', async () => {
    const res = await request(app)
      .post('/api/v1/admin/login')
      .send({ email: 'superadmin@uniquebasket.com', password: 'SuperSecretPassword123' });
    expect(res.statusCode).toEqual(200);
    const adminRefresh = res.body.data.refreshToken;

    expect((await refresh(adminRefresh)).statusCode).toEqual(200);
    await logout({ refreshToken: adminRefresh });
    expect((await refresh(adminRefresh)).statusCode).toEqual(401);
  });
});
