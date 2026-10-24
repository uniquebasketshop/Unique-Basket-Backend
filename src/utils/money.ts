/**
 * P2-03: exact money arithmetic in integer paise (1 rupee = 100 paise).
 * Prices have at most 2 decimals and quantities at most 3 decimals (DB precision).
 * API responses keep using plain rupee numbers; only the arithmetic is exact.
 */

/** Rupees (number, numeric string or Prisma Decimal) → integer paise. */
export function toPaise(rupees: number | string | { toString(): string }): number {
  return Math.round(Number(rupees.toString()) * 100);
}

/** Quantity → integer thousandths (matches Decimal(10, 3)). */
export function toMilliUnits(quantity: number | string | { toString(): string }): number {
  return Math.round(Number(quantity.toString()) * 1000);
}

/** Integer paise → rupees number with at most 2 decimals. */
export function fromPaise(paise: number): number {
  return paise / 100;
}

/**
 * Line total in paise for quantity × unit price, rounded half-up once.
 * Uses BigInt so large quantities × prices cannot overflow.
 */
export function lineTotalPaise(quantity: number | string | { toString(): string }, unitPrice: number | string | { toString(): string }): number {
  const milli = BigInt(toMilliUnits(quantity));
  const paise = BigInt(toPaise(unitPrice));
  return Number((milli * paise + BigInt(500)) / BigInt(1000));
}
