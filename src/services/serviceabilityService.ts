import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Pincode serviceability (current implementation: admin-managed SupportedPincode list).
 * The final serviceability model is DECISION REQUIRED (P4-05); this only centralises the existing rule.
 */
export async function findActivePincode(db: Db, pincode: string) {
  return db.supportedPincode.findFirst({ where: { pincode, isActive: true } });
}

/** Active supported pincode, or 400 PINCODE_NOT_SERVICEABLE. */
export async function requireServiceablePincode(db: Db, pincode: string) {
  const supported = await findActivePincode(db, pincode);
  if (!supported) {
    throw new AppError(400, 'PINCODE_NOT_SERVICEABLE', 'Delivery is currently not available for this pincode.');
  }
  return supported;
}

export async function listActivePincodes() {
  return prisma.supportedPincode.findMany({ where: { isActive: true }, orderBy: { pincode: 'asc' } });
}

/** Serviceability answer for the app. Rajkot/Gujarat fallback is existing behaviour (P4-05 pending). */
export async function checkPincode(pincode: string) {
  const supported = await findActivePincode(prisma, pincode);
  return {
    isServiceable: !!supported,
    pincode,
    city: supported?.city || 'Rajkot',
    state: supported?.state || 'Gujarat',
  };
}
