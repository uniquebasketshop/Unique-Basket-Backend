/**
 * Small request-validation layer (P2-01). No third-party dependency.
 *
 * A schema maps body fields to parsers. Fields are checked in schema order and
 * the first failure is reported with the route's existing stable errorCode,
 * so HTTP contracts stay unchanged: { success: false, message, errorCode }.
 * Parsers also normalise values (trim strings, coerce numeric strings).
 */

export interface ValidationIssue {
  errorCode: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

export type Parser<T> = (value: unknown) => ParseResult<T>;

export type Schema = Record<string, Parser<unknown>>;

export type Infer<S extends Schema> = { [K in keyof S]: S[K] extends Parser<infer T> ? T : never };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (errorCode: string, message: string): ParseResult<never> => ({ ok: false, issue: { errorCode, message } });

/** Validates `input` against `schema`. Returns parsed data or the first issue. */
export function validate<S extends Schema>(
  schema: S,
  input: unknown,
): { ok: true; data: Infer<S> } | { ok: false; issue: ValidationIssue } {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(schema)) {
    const result = parse(source[key]);
    if (!result.ok) return { ok: false, issue: result.issue };
    if (result.value !== undefined) data[key] = result.value;
  }
  return { ok: true, data: data as Infer<S> };
}

const isMissing = (value: unknown) => value === undefined;
const isBlank = (value: unknown) => value === null || (typeof value === 'string' && value.trim() === '');

interface StringOptions {
  errorCode: string;
  message: string;
  /** Allowed max length after trimming, with its own error. */
  max?: { length: number; errorCode: string; message: string };
  pattern?: RegExp;
  /** Error used when the field is absent (defaults to errorCode/message). */
  missing?: ValidationIssue;
}

/** Field parsers. `required*` reject undefined; `optional*` pass undefined through (field not sent). */
export const v = {
  /** Required non-empty string (trimmed). */
  requiredString(opts: StringOptions): Parser<string> {
    return (value) => {
      if (isMissing(value) || isBlank(value)) {
        return fail(opts.missing?.errorCode ?? opts.errorCode, opts.missing?.message ?? opts.message);
      }
      return checkString(value, opts);
    };
  },

  /** Optional non-empty string: absent → undefined; present must be valid. */
  optionalString(opts: StringOptions): Parser<string | undefined> {
    return (value) => (isMissing(value) ? ok(undefined) : checkString(value, opts));
  },

  /** Optional string that may be cleared: absent → undefined; null/'' → null. */
  nullableString(opts: StringOptions): Parser<string | null | undefined> {
    return (value) => {
      if (isMissing(value)) return ok(undefined);
      if (isBlank(value)) return ok(null);
      return checkString(value, opts);
    };
  },

  /** Free text that is stored as-is when it is a string (absent → undefined, null/'' → null). */
  optionalText(opts: { errorCode: string; message: string; maxLength?: number }): Parser<string | null | undefined> {
    return (value) => {
      if (isMissing(value)) return ok(undefined);
      if (isBlank(value)) return ok(null);
      if (typeof value !== 'string') return fail(opts.errorCode, opts.message);
      const trimmed = value.trim();
      if (opts.maxLength !== undefined && trimmed.length > opts.maxLength) return fail(opts.errorCode, opts.message);
      return ok(trimmed);
    };
  },

  /** One of a fixed set of string values. */
  oneOf<T extends string>(values: readonly T[], opts: { errorCode: string; message: string; required?: ValidationIssue }): Parser<T | undefined> {
    return (value) => {
      if (isMissing(value) || isBlank(value)) {
        return opts.required ? fail(opts.required.errorCode, opts.required.message) : ok(undefined);
      }
      return typeof value === 'string' && (values as readonly string[]).includes(value)
        ? ok(value as T)
        : fail(opts.errorCode, opts.message);
    };
  },

  /** Number (or numeric string). Absent → undefined unless `required` is given. */
  number(opts: {
    errorCode: string;
    message: string;
    min?: number;
    max?: number;
    positive?: boolean;
    required?: ValidationIssue;
    nullable?: boolean;
  }): Parser<number | null | undefined> {
    return (value) => {
      if (isMissing(value) || (value === null && !opts.required)) {
        if (opts.required) return fail(opts.required.errorCode, opts.required.message);
        return ok(value === null && opts.nullable ? null : undefined);
      }
      const num = toNumber(value);
      if (num === null) return fail(opts.errorCode, opts.message);
      if (opts.positive && num <= 0) return fail(opts.errorCode, opts.message);
      if (opts.min !== undefined && num < opts.min) return fail(opts.errorCode, opts.message);
      if (opts.max !== undefined && num > opts.max) return fail(opts.errorCode, opts.message);
      return ok(num);
    };
  },

  /** Optional boolean (absent → undefined). Accepts true/false only. */
  optionalBoolean(opts: { errorCode: string; message: string }): Parser<boolean | undefined> {
    return (value) => {
      if (isMissing(value) || value === null) return ok(undefined);
      return typeof value === 'boolean' ? ok(value) : fail(opts.errorCode, opts.message);
    };
  },

  /** Non-empty array whose items each match `itemSchema`. */
  nonEmptyArray<S extends Schema>(
    itemSchema: S,
    opts: { errorCode: string; message: string },
  ): Parser<Infer<S>[]> {
    return (value) => {
      if (!Array.isArray(value) || value.length === 0) return fail(opts.errorCode, opts.message);
      const items: Infer<S>[] = [];
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(opts.errorCode, opts.message);
        const result = validate(itemSchema, item);
        if (!result.ok) return { ok: false, issue: result.issue };
        items.push(result.data);
      }
      return ok(items);
    };
  },

  /** Passes the raw value through unchanged (field validated later by business logic). */
  any(): Parser<unknown> {
    return (value) => ok(value);
  },
};

function checkString(value: unknown, opts: StringOptions): ParseResult<string> {
  if (typeof value !== 'string') return fail(opts.errorCode, opts.message);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(opts.errorCode, opts.message);
  if (opts.pattern && !opts.pattern.test(trimmed)) return fail(opts.errorCode, opts.message);
  if (opts.max && trimmed.length > opts.max.length) return fail(opts.max.errorCode, opts.max.message);
  return ok(trimmed);
}

/** Finite number from a number or a plain numeric string; null otherwise. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}
