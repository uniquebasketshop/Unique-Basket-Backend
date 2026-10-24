import { Request } from 'express';
import { AppError } from './errors';

/**
 * Express 5 types route params as `string | string[]`.
 * Returns a single string value for a named route param.
 */
export function getParam(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * Authenticated user id, or AppError 401 UNAUTHORIZED (rendered as
 * { success: false, message: 'Authentication required.', errorCode: 'UNAUTHORIZED' }).
 * Routes already run `authenticate`; this keeps controllers type-safe without repeating the check.
 */
export function requireUserId(req: Request & { user?: { id?: string } }): string {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  return userId;
}
