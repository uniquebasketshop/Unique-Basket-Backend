/**
 * Standardized Order Number Generator and Formatter for UNIQUE BASKET.
 * Required Format: #UB-DDMMYY-XXX
 * Example: #UB-270926-001
 */

// Sequence: 001…999, then 1000, 1001 … on a very busy day (never a zero-padded 4th digit)
export const ORDER_NUMBER_REGEX = /^#UB-\d{6}-(\d{3}|[1-9]\d{3,})$/;

/**
 * Returns the 6-digit DDMMYY date key for an order in Asia/Kolkata timezone.
 * Example: 2026-09-27 -> "270926"
 */
export function getOrderDateKey(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const year = parts.find((p) => p.type === 'year')?.value ?? '26';
  return `${day}${month}${year}`;
}

/**
 * Formats dateKey and sequential integer into a standard order number.
 * Example: ("270926", 1) -> "#UB-270926-001"
 */
export function formatOrderNumber(dateKey: string, seq: number): string {
  const sequenceStr = String(seq).padStart(3, '0');
  return `#UB-${dateKey}-${sequenceStr}`;
}

/**
 * Validates if an order number string adheres strictly to the standard format (#UB-DDMMYY-XXX).
 */
export function isValidOrderNumber(orderNumber: string): boolean {
  return ORDER_NUMBER_REGEX.test(orderNumber);
}

/**
 * Generates the next sequential order number for the given date in a concurrency-safe manner.
 * Uses PostgreSQL row-level locks on daily_order_sequences via ON CONFLICT DO UPDATE.
 */
export async function generateNextOrderNumber(tx: any, date: Date = new Date()): Promise<string> {
  const dateKey = getOrderDateKey(date);

  // Concurrency-safe atomic increment via PostgreSQL ON CONFLICT DO UPDATE
  const result = await tx.$queryRaw<{ last_seq: number }[]>`
    INSERT INTO "daily_order_sequences" ("date_key", "last_seq", "updated_at")
    VALUES (${dateKey}, 1, NOW())
    ON CONFLICT ("date_key")
    DO UPDATE SET "last_seq" = "daily_order_sequences"."last_seq" + 1, "updated_at" = NOW()
    RETURNING "last_seq";
  `;

  let nextSeq = Number(result[0].last_seq);

  // Guard against collision with any legacy/existing order records
  const candidateNumber = formatOrderNumber(dateKey, nextSeq);
  const existingOrder = await tx.order.findUnique({
    where: { orderNumber: candidateNumber },
  });

  if (existingOrder) {
    // Find all orders starting with #UB-${dateKey}- to determine the highest sequence
    const existingDateOrders = await tx.order.findMany({
      where: {
        orderNumber: {
          startsWith: `#UB-${dateKey}-`,
        },
      },
      select: { orderNumber: true },
    });

    let maxSeq = nextSeq;
    for (const ord of existingDateOrders) {
      const match = ord.orderNumber.match(/^#UB-\d{6}-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxSeq) {
          maxSeq = num;
        }
      }
    }

    const correctedSeq = maxSeq + 1;
    await tx.$executeRaw`
      UPDATE "daily_order_sequences"
      SET "last_seq" = ${correctedSeq}, "updated_at" = NOW()
      WHERE "date_key" = ${dateKey};
    `;
    nextSeq = correctedSeq;
  }

  return formatOrderNumber(dateKey, nextSeq);
}
