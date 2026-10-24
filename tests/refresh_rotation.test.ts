import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { verifyRefreshToken } from '../src/utils/jwt';
import { REFRESH_REUSE_GRACE_MS } from '../src/services/sessionService';

/**
 * Refresh-token rotation with reuse detection: each refresh returns a new refresh token and
 * ends the old one. An old token used again after the grace window signs that device out.
 */
describe('Refresh token rotation', () => {
  const phone = '+919888800311';

  const login = async () => {
    await request(app).post('/api/v1/auth/send-otp').send({ phone });
    const res = await request(app).post('/api/v1/auth/verify-otp').send({ phone, otp: '1234' });
    expect(res.statusCode).toEqual(200);
    return res.body.data as { token: string; refreshToken: string; user: { id: string } };
  };

  const refresh = (refreshToken: string) => request(app).post('/api/v1/auth/refresh').send({ refreshToken });
  const logout = (refreshToken: string) => request(app).post('/api/v1/auth/logout').send({ refreshToken });
  const jti = (token: string) => verifyRefreshToken(token).jti!;

  /** Pretends the token was rotated longer ago than the grace window. */
  const ageRotation = (token: string) =>
    prisma.refreshToken.update({
      where: { id: jti(token) },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5000) },
    });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.$disconnect();
  });

  it('1. returns a new refresh token and keeps the session expiry', async () => {
    const session = await login();
    const res = await refresh(session.refreshToken);

    expect(res.statusCode).toEqual(200);
    expect(typeof res.body.data.token).toBe('string');
    const next = res.body.data.refreshToken as string;
    expect(next).not.toEqual(session.refreshToken);

    const oldRow = await prisma.refreshToken.findUniqueOrThrow({ where: { id: jti(session.refreshToken) } });
    const newRow = await prisma.refreshToken.findUniqueOrThrow({ where: { id: jti(next) } });
    expect(oldRow.revokedAt).not.toBeNull();
    expect(oldRow.replacedById).toEqual(newRow.id);
    expect(newRow.revokedAt).toBeNull();
    expect(newRow.expiresAt.getTime()).toEqual(oldRow.expiresAt.getTime());

    // The new token keeps working, and rotates again
    const again = await refresh(next);
    expect(again.statusCode).toEqual(200);
    expect(again.body.data.refreshToken).not.toEqual(next);
  });

  it('2. an old token reused within the grace window gets the current session (lost response)', async () => {
    const session = await login();
    const first = await refresh(session.refreshToken);
    const current = first.body.data.refreshToken as string;
    const rowsBefore = await prisma.refreshToken.count({ where: { userId: session.user.id } });

    const retry = await refresh(session.refreshToken);

    expect(retry.statusCode).toEqual(200);
    expect(jti(retry.body.data.refreshToken)).toEqual(jti(current));
    expect(await prisma.refreshToken.count({ where: { userId: session.user.id } })).toEqual(rowsBefore);
  });

  it('3. an old token reused after the grace window signs that device out', async () => {
    const session = await login();
    const current = (await refresh(session.refreshToken)).body.data.refreshToken as string;
    await ageRotation(session.refreshToken);

    const reuse = await refresh(session.refreshToken);
    expect(reuse.statusCode).toEqual(401);
    expect(reuse.body.errorCode).toEqual('REFRESH_TOKEN_REUSED');

    // The thief's (or user's) newer token is dead too
    const afterReuse = await refresh(current);
    expect(afterReuse.statusCode).toEqual(401);
  });

  it('4. reuse on one device does not sign out another device', async () => {
    const deviceA = await login();
    const deviceB = await login();
    await refresh(deviceA.refreshToken);
    await ageRotation(deviceA.refreshToken);

    expect((await refresh(deviceA.refreshToken)).body.errorCode).toEqual('REFRESH_TOKEN_REUSED');
    expect((await refresh(deviceB.refreshToken)).statusCode).toEqual(200);
  });

  it('5. two refreshes with the same token at the same time create one new session', async () => {
    const session = await login();
    const rowsBefore = await prisma.refreshToken.count({ where: { userId: session.user.id } });

    const [a, b] = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)]);

    expect(a.statusCode).toEqual(200);
    expect(b.statusCode).toEqual(200);
    expect(jti(a.body.data.refreshToken)).toEqual(jti(b.body.data.refreshToken));
    expect(await prisma.refreshToken.count({ where: { userId: session.user.id } })).toEqual(rowsBefore + 1);
  });

  it('6. logout with the latest token ends the session', async () => {
    const session = await login();
    const current = (await refresh(session.refreshToken)).body.data.refreshToken as string;

    expect((await logout(current)).statusCode).toEqual(200);
    expect((await refresh(current)).statusCode).toEqual(401);
    expect((await refresh(session.refreshToken)).statusCode).toEqual(401);
  });

  it('7. logout with an already rotated token still ends the session', async () => {
    const session = await login();
    const current = (await refresh(session.refreshToken)).body.data.refreshToken as string;

    expect((await logout(session.refreshToken)).statusCode).toEqual(200);
    expect((await refresh(current)).statusCode).toEqual(401);
  });

  it('8. a logged-out token is not revived by the grace window', async () => {
    const session = await login();
    await logout(session.refreshToken);

    const res = await refresh(session.refreshToken);
    expect(res.statusCode).toEqual(401);
    expect(res.body.errorCode).toEqual('INVALID_REFRESH_TOKEN');
  });
});
