import { randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../utils/errors';

/** Refresh token lifetime; must match the JWT expiry in utils/jwt.ts. */
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RefreshSubject {
  id: string;
  role: string;
  jti: string;
}

const invalidSession = () =>
  new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token. Please log in again.');

/**
 * Issues a refresh token backed by a server-side session row (P1-08), so it can be revoked.
 */
export async function issueRefreshToken(subject: { id: string; role: string }): Promise<string> {
  const isCustomer = subject.role === 'customer';
  const session = await prisma.refreshToken.create({
    data: {
      userId: isCustomer ? subject.id : null,
      adminUserId: isCustomer ? null : subject.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return generateRefreshToken({ id: subject.id, role: subject.role }, session.id);
}

/**
 * Verifies the refresh JWT and that its session exists, belongs to the subject,
 * is not revoked and not expired. Throws 401 INVALID_REFRESH_TOKEN otherwise.
 */
export async function validateRefreshToken(token: string): Promise<RefreshSubject> {
  let decoded: { id: string; role: string; jti?: string };
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw invalidSession();
  }

  // Tokens issued before P1-08 carry no session id and are no longer accepted
  if (!decoded.jti) {
    throw invalidSession();
  }

  const session = await prisma.refreshToken.findUnique({ where: { id: decoded.jti } });
  const ownerId = decoded.role === 'customer' ? session?.userId : session?.adminUserId;
  if (!session || session.revokedAt || session.expiresAt <= new Date() || ownerId !== decoded.id) {
    throw invalidSession();
  }

  return { id: decoded.id, role: decoded.role, jti: decoded.jti };
}

/** Revokes a single refresh session (idempotent). */
export async function revokeRefreshSession(jti: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { id: jti, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * A rotated token presented again within this window is treated as a lost response (the app
 * never saved the new token), not as theft: the caller gets a token for the current session.
 */
export const REFRESH_REUSE_GRACE_MS = 60 * 1000;

const ROTATION_CONFLICT = 'REFRESH_ROTATION_CONFLICT';

/**
 * Refresh-token rotation with reuse detection.
 * - Live token: revoke it, create its successor session (same owner, same absolute expiry)
 *   and return a new refresh token for it.
 * - Rotated token within REFRESH_REUSE_GRACE_MS: return a token for the newest live session of
 *   that chain (no new session).
 * - Rotated token after the grace window: treated as stolen; that device's session chain is
 *   revoked and 401 REFRESH_TOKEN_REUSED is thrown. Other devices are not affected.
 * - Revoked by logout/deactivation, expired or forged: 401 INVALID_REFRESH_TOKEN.
 */
export async function rotateRefreshToken(token: string): Promise<RefreshSubject & { refreshToken: string }> {
  let decoded: { id: string; role: string; jti?: string };
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw invalidSession();
  }
  if (!decoded.jti) throw invalidSession();

  const subject = { id: decoded.id, role: decoded.role };
  const ownerOf = (s: { userId: string | null; adminUserId: string | null }) =>
    decoded.role === 'customer' ? s.userId : s.adminUserId;

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await prisma.refreshToken.findUnique({ where: { id: decoded.jti } });
    if (!session || ownerOf(session) !== decoded.id || session.expiresAt <= new Date()) {
      throw invalidSession();
    }

    if (session.revokedAt) {
      if (!session.replacedById) throw invalidSession(); // logout / deactivation

      if (Date.now() - session.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
        const head = await chainHead(session.replacedById);
        if (!head || head.revokedAt || head.expiresAt <= new Date() || ownerOf(head) !== decoded.id) {
          throw invalidSession();
        }
        return { ...subject, jti: head.id, refreshToken: generateRefreshToken(subject, head.id, head.expiresAt) };
      }

      await revokeChain(session.replacedById);
      throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'This session was signed out for security. Please log in again.');
    }

    const nextId = randomUUID();
    try {
      await prisma.$transaction(async (tx) => {
        // Conditional: only one concurrent refresh can rotate this token
        const { count } = await tx.refreshToken.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: nextId },
        });
        if (count === 0) throw new Error(ROTATION_CONFLICT);
        await tx.refreshToken.create({
          data: { id: nextId, userId: session.userId, adminUserId: session.adminUserId, expiresAt: session.expiresAt },
        });
      });
    } catch (error) {
      // Another request rotated it first: go round again and take the grace path
      if ((error as Error)?.message === ROTATION_CONFLICT) continue;
      throw error;
    }
    return { ...subject, jti: nextId, refreshToken: generateRefreshToken(subject, nextId, session.expiresAt) };
  }
  throw invalidSession();
}

/** Follows replaced_by links to the newest session of a chain. */
async function chainHead(startId: string) {
  let current = await prisma.refreshToken.findUnique({ where: { id: startId } });
  for (let hops = 0; current?.replacedById && hops < 1000; hops++) {
    current = await prisma.refreshToken.findUnique({ where: { id: current.replacedById } });
  }
  return current;
}

/** Revokes every session in a chain from startId onwards. */
async function revokeChain(startId: string): Promise<void> {
  let id: string | null = startId;
  for (let hops = 0; id && hops < 1000; hops++) {
    const current: { replacedById: string | null } | null = await prisma.refreshToken.findUnique({
      where: { id },
      select: { replacedById: true },
    });
    await revokeRefreshSession(id);
    id = current?.replacedById ?? null;
  }
}

/**
 * Logout: ends the session of this refresh token, including any later rotations of it, so
 * logging out with a token that was already rotated still signs that device out.
 * Returns the owner, or null for an invalid/expired/forged token (logout stays idempotent).
 */
export async function endSessionForToken(token: string): Promise<{ id: string; role: string } | null> {
  let decoded: { id: string; role: string; jti?: string };
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    return null;
  }
  if (!decoded.jti) return null;

  const session = await prisma.refreshToken.findUnique({ where: { id: decoded.jti } });
  const ownerId = decoded.role === 'customer' ? session?.userId : session?.adminUserId;
  if (!session || ownerId !== decoded.id) return null;

  await revokeChain(session.id);
  return { id: decoded.id, role: decoded.role };
}
