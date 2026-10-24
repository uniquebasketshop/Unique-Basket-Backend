import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Code defaults used when no DeliverySettings row exists.
 * These mirror the schema defaults and the owner-confirmed values (D-009).
 */
const DEFAULTS = {
  deliveryEnabled: true,
  deliveryFee: 30.0,
  freeDeliveryThreshold: 200.0,
  minimumOrderAmount: 199.0,
  codEnabled: true,
  codCharge: 20.0,
  minimumCodOrderAmount: 100.0,
  maximumCodOrderAmount: 5000.0,
  pickupCodEnabled: true,
};

export type FareSettings = typeof DEFAULTS;

/** Loads fare/COD settings as plain numbers, falling back to code defaults. */
export async function loadFareSettings(db: Db): Promise<FareSettings> {
  const s = await db.deliverySettings.findFirst();
  if (!s) return { ...DEFAULTS };
  return {
    deliveryEnabled: s.deliveryEnabled,
    deliveryFee: Number(s.deliveryFee),
    freeDeliveryThreshold: Number(s.freeDeliveryThreshold),
    minimumOrderAmount: Number(s.minimumOrderAmount),
    codEnabled: s.codEnabled,
    codCharge: Number(s.codCharge),
    minimumCodOrderAmount: Number(s.minimumCodOrderAmount),
    maximumCodOrderAmount: Number(s.maximumCodOrderAmount),
    pickupCodEnabled: s.pickupCodEnabled,
  };
}

/** Delivery fee for a DELIVERY order subtotal (single source of truth for cart and checkout). */
export function calculateDeliveryFee(subtotal: number, settings: FareSettings): number {
  return subtotal >= settings.freeDeliveryThreshold ? 0 : settings.deliveryFee;
}
