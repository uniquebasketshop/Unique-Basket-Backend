import { Request, Response, NextFunction } from 'express';

/**
 * Minimal structured logging (P3-04). JSON lines in production, readable lines elsewhere.
 * Never pass secrets, tokens, OTPs or request bodies as fields.
 */
type Level = 'info' | 'warn' | 'error';

export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = process.env.NODE_ENV === 'production'
    ? JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
    : `[${level}] ${event} ${JSON.stringify(fields)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** True when verbose content (e.g. notification text) may be logged. */
export const isVerboseLogging = (): boolean =>
  process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

/**
 * One log line per request: method, path (no query string), status, duration, client IP.
 * Disabled under NODE_ENV=test unless LOG_REQUESTS=true.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'test' && process.env.LOG_REQUESTS !== 'true') {
    next();
    return;
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    logEvent(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - start) / BigInt(1_000_000)),
      ip: req.ip,
    });
  });
  next();
}
