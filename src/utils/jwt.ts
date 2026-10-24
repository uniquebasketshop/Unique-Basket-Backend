import jwt from 'jsonwebtoken';
import { requireEnv } from '../config/validateEnv';

// Secrets are read at call time and have no default values (P0-02).
const accessSecret = (): string => requireEnv('JWT_SECRET');
const refreshSecret = (): string => requireEnv('JWT_REFRESH_SECRET');

export interface TokenPayload {
  id: string;
  role: 'customer' | 'SUPER_ADMIN' | 'STORE_MANAGER';
  phone?: string;
  email?: string;
  storeId?: string; // Store ID mapped to Store Manager
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, accessSecret(), { expiresIn: '15m' });
}

/**
 * Signs a refresh token. `sessionId` (JWT `jti`) links it to a revocable refresh_tokens row (P1-08).
 * Use services/sessionService.issueRefreshToken rather than calling this directly.
 */
export function generateRefreshToken(
  payload: { id: string; role: string },
  sessionId?: string,
  expiresAt?: Date,
): string {
  // A rotated token keeps its session's original expiry (absolute 7-day session lifetime).
  const expiresIn = expiresAt ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : '7d';
  return jwt.sign(payload, refreshSecret(), { expiresIn, ...(sessionId ? { jwtid: sessionId } : {}) });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, accessSecret()) as TokenPayload;
}

export function verifyRefreshToken(token: string): { id: string; role: string; jti?: string } {
  return jwt.verify(token, refreshSecret()) as { id: string; role: string; jti?: string };
}
