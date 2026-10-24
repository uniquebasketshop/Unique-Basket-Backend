import { Prisma, ProductUnit } from '@prisma/client';
import { AppError } from '../utils/errors';
import { calculateHaversineDistance } from '../utils/distance';
import { fromPaise, lineTotalPaise, toPaise } from '../utils/money';
import { snapshotDeliveryAddress } from '../utils/orderAddress';
import { validateProductQuantity } from '../utils/quantity';
import { calculateDeliveryFee, FareSettings } from './pricingService';
import { deductStockForOrder } from './inventoryService';
import { isLocationConfirmed } from './addressService';
import { findActivePincode } from './serviceabilityService';

type Tx = Prisma.TransactionClient;

/**
 * Order placement building blocks (P2-01 service extraction).
 * Errors keep the exact codes/messages the order controller already maps to HTTP responses.
 */

export type FulfillmentInput =
  | { fulfillmentType: 'DELIVERY'; addressId?: string }
  | { fulfillmentType: 'PICKUP'; storeId?: string }
  | { fulfillmentType: string; addressId?: string; storeId?: string };

export interface ResolvedFulfillment {
  storeId: string;
  deliveryAddressSnapshot?: ReturnType<typeof snapshotDeliveryAddress>;
}

/** Nearest active store whose delivery radius covers the point, or null. */
export async function findNearestDeliveryStore(tx: Tx, lat: number, lng: number) {
  const activeStores = await tx.store.findMany({ where: { isActive: true } });
  let nearest: (typeof activeStores)[number] | null = null;
  let minDistance = Infinity;
  for (const store of activeStores) {
    const distance = calculateHaversineDistance(lat, lng, Number(store.latitude), Number(store.longitude));
    if (distance <= Number(store.deliveryRadiusKm) && distance < minDistance) {
      minDistance = distance;
      nearest = store;
    }
  }
  return nearest;
}

/**
 * Store that delivers to an address (D-017, serviceability rule iii):
 * - confirmed GPS location → nearest active store whose delivery radius covers it (null if none);
 * - location not confirmed (typed address) → active store in the same pincode, else the first
 *   active store (by store code). The pincode itself was checked against the serviceable list
 *   when the address was saved.
 */
export async function resolveDeliveryStore(
  tx: Tx,
  address: { latitude: unknown; longitude: unknown; pincode: string },
) {
  if (isLocationConfirmed(address)) {
    return findNearestDeliveryStore(tx, Number(address.latitude), Number(address.longitude));
  }
  const samePincode = await tx.store.findFirst({ where: { isActive: true, pincode: address.pincode }, orderBy: { storeId: 'asc' } });
  return samePincode ?? tx.store.findFirst({ where: { isActive: true }, orderBy: { storeId: 'asc' } });
}

/**
 * Resolves which store fulfils the order.
 * DELIVERY: the customer's address → resolveDeliveryStore (snapshot of the address is returned).
 * PICKUP: the chosen store must exist and be active.
 */
export async function resolveFulfillment(
  tx: Tx,
  userId: string,
  fares: FareSettings,
  input: { fulfillmentType: string; addressId?: string; storeId?: string },
): Promise<ResolvedFulfillment> {
  if (input.fulfillmentType === 'DELIVERY') {
    if (!fares.deliveryEnabled) throw new Error('DELIVERY_DISABLED');
    if (!input.addressId) {
      throw new AppError(400, 'MISSING_ADDRESS_ID', 'Address ID is required for delivery fulfillment.');
    }
    const address = await tx.userAddress.findUnique({ where: { id: input.addressId } });
    if (!address || address.userId !== userId) {
      throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Delivery address not found.');
    }
    // D-017: the pincode must still be serviceable when ordering (it may have been deactivated).
    if (!(await findActivePincode(tx, address.pincode))) {
      throw new AppError(400, 'PINCODE_NOT_SERVICEABLE', 'Delivery is currently not available for this pincode.');
    }
    const store = await resolveDeliveryStore(tx, address);
    if (!store) throw new Error('NO_DELIVERY_AVAILABLE');
    return { storeId: store.id, deliveryAddressSnapshot: snapshotDeliveryAddress(address) };
  }

  if (input.fulfillmentType === 'PICKUP') {
    if (!input.storeId) throw new AppError(400, 'MISSING_STORE_ID', 'Store ID is required for pickup fulfillment.');
    const store = await tx.store.findUnique({ where: { id: input.storeId } });
    if (!store || !store.isActive) {
      throw new AppError(400, 'STORE_UNAVAILABLE', 'Selected store is inactive or unavailable.');
    }
    return { storeId: store.id };
  }

  throw new AppError(400, 'INVALID_FULFILLMENT_TYPE', 'Invalid fulfillment type.');
}

export interface OrderLine {
  productId: string;
  productName: string;
  unit: ProductUnit;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/**
 * Validates each requested item (active product + category, D-012 quantity rules),
 * deducts stock at the store, and prices the lines with exact paise arithmetic.
 */
/** Most lines one order may have (technical limit; a cart has one line per product). */
export const MAX_ORDER_LINES = 100;

/**
 * Item list rules checked before any database work: at most MAX_ORDER_LINES lines and each
 * product once. Repeating a product would check its max-quantity rule per line, not in total.
 */
export function assertOrderItems(items: { productId: string }[]): void {
  if (items.length > MAX_ORDER_LINES) {
    throw new AppError(400, 'TOO_MANY_ITEMS', `An order can have at most ${MAX_ORDER_LINES} products.`);
  }
  const seen = new Set<string>();
  for (const { productId } of items) {
    if (seen.has(productId)) {
      throw new AppError(400, 'DUPLICATE_ORDER_ITEM', 'Each product can appear only once in an order.');
    }
    seen.add(productId);
  }
}

export async function reserveOrderLines(
  tx: Tx,
  storeId: string,
  items: { productId: string; quantity: number }[],
): Promise<{ lines: OrderLine[]; subtotalPaise: number }> {
  const lines: OrderLine[] = [];
  let subtotalPaise = 0;

  for (const { productId, quantity } of items) {
    const product = await tx.product.findUnique({ where: { id: productId }, include: { category: true } });
    if (!product || !product.isActive || !product.category.isActive) {
      throw new AppError(400, 'PRODUCT_UNAVAILABLE', `Product with ID ${productId} is not available.`);
    }

    const quantityError = validateProductQuantity(product, quantity);
    if (quantityError) throw new AppError(400, 'INVALID_QUANTITY', quantityError);

    await deductStockForOrder(tx, { storeId, productId, quantity, productName: product.name, unit: product.unit });

    const totalPaise = lineTotalPaise(quantity, product.price);
    subtotalPaise += totalPaise;
    lines.push({
      productId,
      productName: product.name,
      unit: product.unit,
      quantity,
      unitPrice: Number(product.price),
      totalPrice: fromPaise(totalPaise),
    });
  }

  return { lines, subtotalPaise };
}

export interface OrderCharges {
  subtotal: number;
  deliveryFee: number;
  codCharge: number;
  total: number;
}

/**
 * Applies the fare rules (D-009, admin-configurable): delivery minimum and fee,
 * COD availability, COD limits and charge. Pickup (D-016, D-018): no delivery fee,
 * no minimum, and Pay at Store is always available with no COD charge or limits. Pure: no database access.
 * Throws the controller's existing error tokens (MINIMUM_DELIVERY_AMOUNT_NOT_MET:<min>, COD_DISABLED, …).
 */
export function calculateOrderCharges(
  fares: FareSettings,
  fulfillmentType: string,
  paymentMethod: string,
  subtotalPaise: number,
): OrderCharges {
  const subtotal = fromPaise(subtotalPaise);

  let deliveryFee = 0;
  if (fulfillmentType === 'DELIVERY') {
    if (subtotal < fares.minimumOrderAmount) {
      throw new Error(`MINIMUM_DELIVERY_AMOUNT_NOT_MET:${fares.minimumOrderAmount}`);
    }
    deliveryFee = calculateDeliveryFee(subtotal, fares);
  }

  let codCharge = 0;
  // Pay at Store for pickup (D-018) is always available: no COD switch, charge or amount limits.
  if (paymentMethod === 'COD' && fulfillmentType !== 'PICKUP') {
    if (!fares.codEnabled) throw new Error('COD_DISABLED');
    if (subtotal < fares.minimumCodOrderAmount) throw new Error(`MINIMUM_COD_AMOUNT_NOT_MET:${fares.minimumCodOrderAmount}`);
    if (subtotal > fares.maximumCodOrderAmount) throw new Error(`MAXIMUM_COD_AMOUNT_EXCEEDED:${fares.maximumCodOrderAmount}`);
    codCharge = fares.codCharge;
  }

  return {
    subtotal,
    deliveryFee,
    codCharge,
    total: fromPaise(subtotalPaise + toPaise(deliveryFee) + toPaise(codCharge)),
  };
}
