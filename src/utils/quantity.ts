import { Prisma, ProductUnit } from '@prisma/client';

/** DB column precision for quantities: Decimal(10, 3). */
export const MAX_QUANTITY_DECIMALS = 3;
export const MAX_QUANTITY = 9999999.999;

/**
 * Decimal places allowed per unit.
 * - PIECE: whole numbers (D-007).
 * - PACK / DOZEN: whole numbers (D-012).
 * - GRAM: whole grams (D-012: GRAM quantities use gram precision).
 * - KG: up to 3 decimals, i.e. gram precision (D-012).
 */
const UNIT_DECIMALS: Record<ProductUnit, number> = {
  [ProductUnit.KG]: 3,
  [ProductUnit.GRAM]: 0,
  [ProductUnit.PIECE]: 0,
  [ProductUnit.PACK]: 0,
  [ProductUnit.DOZEN]: 0,
};

export const decimalsForUnit = (unit: ProductUnit): number => UNIT_DECIMALS[unit] ?? MAX_QUANTITY_DECIMALS;

/** Product-level purchase rule (D-012). All values are in the product's unit. */
export interface QuantityRule {
  min: number;
  max: number;
  step: number;
}

type DecimalLike = Prisma.Decimal | number | string | null | undefined;

export interface QuantityConfigured {
  unit: ProductUnit;
  minQuantity?: DecimalLike;
  maxQuantity?: DecimalLike;
  quantityStep?: DecimalLike;
}

const countDecimals = (value: number): number => {
  const text = value.toString();
  if (text.includes('e')) return Number.POSITIVE_INFINITY;
  const [, decimals = ''] = text.split('.');
  return decimals.length;
};

/** Integer thousandths, used for exact step arithmetic (values already have <= 3 decimals). */
const toMilli = (value: number): number => Math.round(value * 1000);

const formatQty = (value: number, unit: ProductUnit): string => `${value} ${unit}`;

/**
 * Validates a positive quantity for a product unit (precision and range only).
 * Returns an error message, or null when valid.
 */
export function validateQuantityForUnit(unit: ProductUnit, quantity: number): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return 'Quantity must be a positive number.';
  }
  if (quantity > MAX_QUANTITY) {
    return `Quantity cannot exceed ${MAX_QUANTITY}.`;
  }
  const allowed = decimalsForUnit(unit);
  if (countDecimals(quantity) > allowed) {
    if (allowed === 0) return `Quantity for ${unit} products must be a whole number.`;
    return `Quantity cannot have more than ${allowed} decimal places.`;
  }
  return null;
}

/** Reads a product's configured rule, or null when the product has no quantity configuration. */
export function quantityRuleOf(product: QuantityConfigured): QuantityRule | null {
  if (product.minQuantity == null || product.maxQuantity == null || product.quantityStep == null) return null;
  return {
    min: Number(product.minQuantity),
    max: Number(product.maxQuantity),
    step: Number(product.quantityStep),
  };
}

/**
 * Validates an admin-supplied quantity configuration for a unit.
 * Rules: min > 0, max >= min, step > 0, unit precision on all three values,
 * step no larger than the range (when min < max), and max reachable from min in whole steps.
 */
export function validateQuantityRule(unit: ProductUnit, rule: QuantityRule): string | null {
  const { min, max, step } = rule;
  for (const [label, value] of [['Minimum quantity', min], ['Maximum quantity', max], ['Quantity step', step]] as const) {
    if (!Number.isFinite(value) || value <= 0) return `${label} must be greater than 0.`;
    if (value > MAX_QUANTITY) return `${label} cannot exceed ${MAX_QUANTITY}.`;
    const allowed = decimalsForUnit(unit);
    if (countDecimals(value) > allowed) {
      return allowed === 0
        ? `${label} for ${unit} products must be a whole number.`
        : `${label} cannot have more than ${allowed} decimal places for ${unit} products.`;
    }
  }
  if (max < min) return 'Maximum quantity must be greater than or equal to the minimum quantity.';
  const range = toMilli(max) - toMilli(min);
  if (range > 0 && toMilli(step) > range) {
    return 'Quantity step cannot be larger than the range between minimum and maximum quantity.';
  }
  if (range % toMilli(step) !== 0) {
    return 'Maximum quantity must be reachable from the minimum quantity in whole steps.';
  }
  return null;
}

/** Validates a purchase quantity against the product's unit and its configured rule (if any). */
export function validateProductQuantity(product: QuantityConfigured, quantity: number): string | null {
  const unitError = validateQuantityForUnit(product.unit, quantity);
  if (unitError) return unitError;

  const rule = quantityRuleOf(product);
  if (!rule) return null; // Not configured: unit rules only (behaviour before D-012).

  if (quantity < rule.min) return `Minimum quantity is ${formatQty(rule.min, product.unit)}.`;
  if (quantity > rule.max) return `Maximum quantity is ${formatQty(rule.max, product.unit)}.`;
  if ((toMilli(quantity) - toMilli(rule.min)) % toMilli(rule.step) !== 0) {
    return `Quantity must be ${formatQty(rule.min, product.unit)} plus multiples of ${formatQty(rule.step, product.unit)}.`;
  }
  return null;
}

const CONFIG_FIELDS = ['minQuantity', 'maxQuantity', 'quantityStep'] as const;

export type QuantityConfigData = { minQuantity: number | null; maxQuantity: number | null; quantityStep: number | null };

/**
 * Parses quantity configuration from an admin request body.
 * - None of the three fields present → `{ data: undefined }` (leave unchanged).
 * - All three null/empty → clears the configuration.
 * - Otherwise all three are required and validated against `unit`.
 */
export function parseQuantityConfig(
  body: Record<string, unknown>,
  unit: ProductUnit,
): { data?: QuantityConfigData; error?: string } {
  const present = CONFIG_FIELDS.filter((f) => body[f] !== undefined);
  if (present.length === 0) return {};

  const isEmpty = (v: unknown) => v === null || (typeof v === 'string' && v.trim() === '');
  const values = CONFIG_FIELDS.map((f) => body[f]);
  if (present.length === CONFIG_FIELDS.length && values.every(isEmpty)) {
    return { data: { minQuantity: null, maxQuantity: null, quantityStep: null } };
  }
  if (present.length !== CONFIG_FIELDS.length || values.some(isEmpty)) {
    return { error: 'minQuantity, maxQuantity and quantityStep must be provided together.' };
  }

  const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  const rule = { min: toNumber(body.minQuantity), max: toNumber(body.maxQuantity), step: toNumber(body.quantityStep) };
  const error = validateQuantityRule(unit, rule);
  if (error) return { error };
  return { data: { minQuantity: rule.min, maxQuantity: rule.max, quantityStep: rule.step } };
}
