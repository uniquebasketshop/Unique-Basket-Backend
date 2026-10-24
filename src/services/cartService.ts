import { prisma } from '../config/db';
import { fromPaise, lineTotalPaise, toPaise } from '../utils/money';
import { calculateDeliveryFee, loadFareSettings } from './pricingService';

const asNumberOrNull = (value: unknown) => (value != null ? Number(value) : null);

/**
 * Server-authoritative cart summary (P2-01 service extraction).
 * Excludes lines checkout would reject (inactive product or category, P1-05),
 * prices lines in exact paise (P2-03) and applies the same delivery fee rule as checkout.
 * PICKUP (D-016, D-018): no delivery fee, no minimum order amount and no COD charge.
 */
export async function getCartSummary(userId: string, fulfillmentType: 'DELIVERY' | 'PICKUP' = 'DELIVERY') {
  const cartItems = await prisma.cartItem.findMany({
    where: { userId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          mrp: true,
          unit: true,
          minQuantity: true,
          maxQuantity: true,
          quantityStep: true,
          isActive: true,
          category: { select: { isActive: true } },
        },
      },
    },
  });

  const activeItems = cartItems.filter((item) => item.product.isActive && item.product.category.isActive);

  let subtotalPaise = 0;
  const items = activeItems.map((item) => {
    const quantity = Number(item.quantity);
    const totalPaise = lineTotalPaise(quantity, item.product.price);
    subtotalPaise += totalPaise;
    return {
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      unit: item.product.unit,
      minQuantity: asNumberOrNull(item.product.minQuantity),
      maxQuantity: asNumberOrNull(item.product.maxQuantity),
      quantityStep: asNumberOrNull(item.product.quantityStep),
      price: Number(item.product.price),
      mrp: item.product.mrp ? Number(item.product.mrp) : null,
      quantity,
      totalPrice: fromPaise(totalPaise),
    };
  });

  const subtotal = fromPaise(subtotalPaise);
  const fares = await loadFareSettings(prisma);
  const isPickup = fulfillmentType === 'PICKUP';
  // No delivery fee for pickup, when the cart is empty or when delivery is disabled.
  const deliveryFee =
    !isPickup && activeItems.length > 0 && fares.deliveryEnabled ? calculateDeliveryFee(subtotal, fares) : 0.0;

  return {
    items,
    subtotal,
    deliveryFee,
    total: fromPaise(subtotalPaise + toPaise(deliveryFee)),
    freeDeliveryThreshold: fares.freeDeliveryThreshold,
    deliveryEnabled: fares.deliveryEnabled,
    minimumOrderAmount: isPickup ? 0 : fares.minimumOrderAmount,
    // Added to the total by checkout when paying cash on delivery (D-009); shown by the app so the
    // bill matches. Paying at the store for pickup has no COD charge (D-018).
    codCharge: !isPickup && fares.codEnabled && activeItems.length > 0 ? fares.codCharge : 0,
    fulfillmentType,
  };
}
