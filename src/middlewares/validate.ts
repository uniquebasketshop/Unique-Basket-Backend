import { Request, Response, NextFunction } from 'express';
import { Infer, Schema, validate } from '../validation/validator';

const BODY_KEY = 'validatedBody';

/**
 * Validates `req.body` against `schema` (P2-01). On failure responds
 * 400 { success: false, message, errorCode } with the route's stable errorCode.
 * On success the parsed/normalised body is available via `validatedBody(res)`.
 */
export const validateBody =
  <S extends Schema>(schema: S) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = validate(schema, req.body);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.issue.message, errorCode: result.issue.errorCode });
      return;
    }
    res.locals[BODY_KEY] = result.data;
    next();
  };

/** Parsed body set by `validateBody` for the given schema. */
export const validatedBody = <S extends Schema>(res: Response, _schema: S): Infer<S> => res.locals[BODY_KEY] as Infer<S>;
