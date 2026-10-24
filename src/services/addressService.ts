import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';
import { requireServiceablePincode } from './serviceabilityService';

type Tx = Prisma.TransactionClient;

/**
 * Customer address book (P2-01 service extraction).
 * Invariant: a customer with addresses has exactly one default address.
 * Every flow that changes the default runs in one transaction.
 */

// Rajkot centre — stored when the app sends no coordinates (typed address, location permission
// denied). Such an address is "location not confirmed" (D-017): its store is chosen by pincode.
export const FALLBACK_LATITUDE = 22.3039;
export const FALLBACK_LONGITUDE = 70.8022;

/** True when the address has real (GPS) coordinates rather than the fallback point (D-017). */
export function isLocationConfirmed(address: { latitude: unknown; longitude: unknown }): boolean {
  return !(Number(address.latitude) === FALLBACK_LATITUDE && Number(address.longitude) === FALLBACK_LONGITUDE);
}

/** API shape: the stored address plus `locationConfirmed` (D-017). */
export function withLocationStatus<T extends { latitude: unknown; longitude: unknown }>(address: T) {
  return { ...address, locationConfirmed: isLocationConfirmed(address) };
}

const ADDRESS_NOT_FOUND = () => new AppError(404, 'ADDRESS_NOT_FOUND', 'Address not found.');

export interface NewAddress {
  title?: string | null;
  addressLine: string;
  city?: string | null;
  state?: string | null;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
  isDefault?: boolean;
}

export type AddressChanges = Partial<NewAddress>;

export async function listAddresses(userId: string) {
  const addresses = await prisma.userAddress.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return addresses.map(withLocationStatus);
}

async function findOwnedAddress(tx: Tx | typeof prisma, userId: string, id: string) {
  const address = await tx.userAddress.findFirst({ where: { id, userId } });
  if (!address) throw ADDRESS_NOT_FOUND();
  return address;
}

/** Creates an address in a serviceable pincode. The first address becomes the default. */
export async function createAddress(userId: string, input: NewAddress) {
  const hasCoordinates = input.latitude != null && input.longitude != null;
  const created = await prisma.$transaction(async (tx) => {
    const supported = await requireServiceablePincode(tx, input.pincode);

    const existingCount = await tx.userAddress.count({ where: { userId } });
    const makeDefault = input.isDefault ?? existingCount === 0;
    if (makeDefault && existingCount > 0) {
      await tx.userAddress.updateMany({ where: { userId }, data: { isDefault: false } });
    }

    return tx.userAddress.create({
      data: {
        userId,
        title: input.title || 'Home',
        addressLine: input.addressLine,
        city: input.city || supported.city,
        state: input.state || supported.state,
        pincode: input.pincode,
        // Both coordinates or neither: a half-sent location is treated as not confirmed.
        latitude: hasCoordinates ? input.latitude! : FALLBACK_LATITUDE,
        longitude: hasCoordinates ? input.longitude! : FALLBACK_LONGITUDE,
        isDefault: makeDefault,
      },
    });
  });
  return withLocationStatus(created);
}

/** Updates an owned address; a new pincode must be serviceable. */
export async function updateAddress(userId: string, id: string, changes: AddressChanges) {
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await findOwnedAddress(tx, userId, id);
    if (changes.pincode !== undefined) await requireServiceablePincode(tx, changes.pincode);

    if (changes.isDefault === true) {
      await tx.userAddress.updateMany({ where: { userId, NOT: { id } }, data: { isDefault: false } });
    }

    return tx.userAddress.update({
      where: { id },
      data: {
        // null/empty title/city/state are ignored rather than clearing required columns
        ...(changes.title ? { title: changes.title } : {}),
        ...(changes.addressLine !== undefined ? { addressLine: changes.addressLine } : {}),
        ...(changes.city ? { city: changes.city } : {}),
        ...(changes.state ? { state: changes.state } : {}),
        ...(changes.pincode !== undefined ? { pincode: changes.pincode } : {}),
        // Coordinates are updated together (D-017: confirming the location sends both). If the
        // address moves (new pincode or address line) without new GPS, the old point no longer
        // applies: it becomes "location not confirmed".
        ...(changes.latitude != null && changes.longitude != null
          ? { latitude: changes.latitude, longitude: changes.longitude }
          : movedWithoutLocation(existing, changes)
            ? { latitude: FALLBACK_LATITUDE, longitude: FALLBACK_LONGITUDE }
            : {}),
        // The default can only move to another address (setDefaultAddress), never be switched off.
        ...(changes.isDefault === true ? { isDefault: true } : {}),
      },
    });
  });
  return withLocationStatus(updated);
}

function movedWithoutLocation(existing: { pincode: string; addressLine: string }, changes: AddressChanges): boolean {
  const pincodeChanged = changes.pincode !== undefined && changes.pincode !== existing.pincode;
  const lineChanged = changes.addressLine !== undefined && changes.addressLine.trim() !== existing.addressLine.trim();
  return pincodeChanged || lineChanged;
}

/** Makes an owned address the only default. */
export async function setDefaultAddress(userId: string, id: string) {
  const updated = await prisma.$transaction(async (tx) => {
    await findOwnedAddress(tx, userId, id);
    await tx.userAddress.updateMany({ where: { userId, NOT: { id } }, data: { isDefault: false } });
    return tx.userAddress.update({ where: { id }, data: { isDefault: true } });
  });
  return withLocationStatus(updated);
}

/** Deletes an owned address; if it was the default, the newest remaining address becomes default. */
export async function deleteAddress(userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await findOwnedAddress(tx, userId, id);
    await tx.userAddress.delete({ where: { id } });

    if (existing.isDefault) {
      const remaining = await tx.userAddress.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
      if (remaining.length > 0 && !remaining.some((a) => a.isDefault)) {
        await tx.userAddress.update({ where: { id: remaining[0].id }, data: { isDefault: true } });
      }
    }
  });
}
