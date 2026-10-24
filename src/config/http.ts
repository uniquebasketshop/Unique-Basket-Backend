import { Request, Response, NextFunction, Express } from 'express';
import { CorsOptions } from 'cors';

/**
 * P3-03 HTTP hardening. Everything here is environment-driven so it does not depend on
 * the (pending) hosting decision.
 */

const isDevOrTest = (): boolean =>
  process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

/** Comma-separated list of allowed browser origins, e.g. "https://admin.example.com". */
export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Browser origins allowed to call the API.
 * - CORS_ORIGINS set: only those origins.
 * - Not set: any origin in development/test; none in production (mobile apps are unaffected by CORS).
 * Requests without an Origin header (mobile app, server-to-server, curl) are always allowed.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const configured = allowedOrigins();
  if (configured.length > 0) return configured.includes(origin);
  return isDevOrTest();
}

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
};

/** Conservative security headers for a JSON API. */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * TRUST_PROXY: number of reverse-proxy hops in front of the API (e.g. "1"), or "true".
 * Needed so req.ip (rate limiting, logs) is the client IP behind a load balancer.
 */
export function configureProxyTrust(app: Express): void {
  const value = process.env.TRUST_PROXY;
  if (!value) return;
  if (value === 'true') {
    app.set('trust proxy', true);
  } else if (/^\d+$/.test(value)) {
    app.set('trust proxy', Number(value));
  } else {
    app.set('trust proxy', value);
  }
}

/** Maximum JSON / urlencoded request body size. */
export const BODY_LIMIT = process.env.BODY_LIMIT || '100kb';
