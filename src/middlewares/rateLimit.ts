import { Request, Response, NextFunction } from 'express';

/**
 * Minimal fixed-window, in-memory rate limiter (P1-11).
 * Suitable for a single API instance; a shared store is needed when running multiple instances.
 * Disabled under NODE_ENV=test unless RATE_LIMIT_IN_TESTS=true, so functional tests are not throttled.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  /** Name used to separate counters between limiters. */
  name: string;
  windowMs: number;
  max: number;
  /** Builds the counter key; defaults to client IP. */
  key?: (req: Request) => string;
}

const buckets = new Map<string, Bucket>();
const SWEEP_THRESHOLD = 10000;

function isEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' || process.env.RATE_LIMIT_IN_TESTS === 'true';
}

function sweepExpired(now: number): void {
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isEnabled()) {
      next();
      return;
    }

    const now = Date.now();
    if (buckets.size > SWEEP_THRESHOLD) sweepExpired(now);

    const key = `${options.name}:${(options.key ?? clientIp)(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        errorCode: 'RATE_LIMITED',
      });
      return;
    }

    next();
  };
}

/** Test helper: clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Auth endpoint limits (technical defaults; per IP, plus per identity where applicable). */
export const authRateLimits = {
  sendOtpPerIp: rateLimit({ name: 'send-otp-ip', windowMs: FIFTEEN_MINUTES, max: 20 }),
  verifyOtpPerIp: rateLimit({ name: 'verify-otp-ip', windowMs: FIFTEEN_MINUTES, max: 30 }),
  refreshPerIp: rateLimit({ name: 'refresh-ip', windowMs: FIFTEEN_MINUTES, max: 60 }),
  adminLoginPerIp: rateLimit({ name: 'admin-login-ip', windowMs: FIFTEEN_MINUTES, max: 20 }),
  adminLoginPerEmail: rateLimit({
    name: 'admin-login-email',
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    key: (req) => lower(req.body?.email) || clientIp(req),
  }),
};

/** Public (no-login) read endpoints: generous per-IP cap against scraping/flooding. */
export const publicReadPerIp = rateLimit({ name: 'public-read-ip', windowMs: FIFTEEN_MINUTES, max: 300 });
