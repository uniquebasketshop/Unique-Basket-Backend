import { Prisma, UserAddress } from '@prisma/client';
import { isLocationConfirmed } from '../services/addressService';

/**
 * P1-02: immutable copy of a delivery address stored on the order at checkout, including
 * whether the customer confirmed the pin with GPS (D-017) so delivery can navigate to it.
 */
export function snapshotDeliveryAddress(address: UserAddress): Prisma.InputJsonObject {
  return {
    id: address.id,
    title: address.title,
    addressLine: address.addressLine,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    latitude: Number(address.latitude),
    longitude: Number(address.longitude),
    locationConfirmed: isLocationConfirmed(address),
  };
}

/**
 * The order's `address` is the address *as it was when the order was placed* (the snapshot),
 * not the customer's current address row: editing "Home" later must not move a placed
 * order's delivery. Falls back to the live row only for old orders without a snapshot.
 * Always includes `locationConfirmed`.
 */
export function withDeliveryAddress<T extends { address?: unknown; deliveryAddressSnapshot?: unknown }>(order: T): T {
  const snapshot = order.deliveryAddressSnapshot as Record<string, unknown> | null | undefined;
  const live = order.address as Record<string, unknown> | null | undefined;
  const base = snapshot && typeof snapshot === 'object' ? { ...(live ?? {}), ...snapshot } : live;
  if (!base) return order;
  const address = {
    ...base,
    locationConfirmed:
      typeof base.locationConfirmed === 'boolean'
        ? base.locationConfirmed
        : isLocationConfirmed({ latitude: base.latitude, longitude: base.longitude }),
  };
  return { ...order, address };
}
