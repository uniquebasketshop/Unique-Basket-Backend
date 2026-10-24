import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/errors';

type Tx = Prisma.TransactionClient;

/**
 * Thrown when an order's status changed between validation and update (concurrent request).
 */
export const ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED';

/**
 * Atomically moves an order from `expectedStatus` to `nextStatus`.
 * Only one concurrent caller can win; others get ORDER_STATUS_CHANGED.
 */
export async function claimOrderStatus(
  tx: Tx,
  orderId: string,
  expectedStatus: OrderStatus,
  nextStatus: OrderStatus,
  paymentStatus?: PaymentStatus
) {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, orderStatus: expectedStatus },
    data: {
      orderStatus: nextStatus,
      ...(paymentStatus ? { paymentStatus } : {}),
      updatedAt: new Date(),
    },
  });

  if (count === 0) {
    throw new Error(ORDER_STATUS_CHANGED);
  }

  return tx.order.findUniqueOrThrow({ where: { id: orderId } });
}

/**
 * Restores stock for every item of an order using atomic increments
 * (safe against concurrent checkouts/adjustments) and logs each change.
 * Creates the inventory row if it no longer exists.
 */
export async function restoreOrderStock(
  tx: Tx,
  params: {
    orderId: string;
    storeId: string;
    reason: string;
    performedByAdminId?: string | null;
  }
): Promise<void> {
  const items = await tx.orderItem.findMany({ where: { orderId: params.orderId } });

  for (const item of items) {
    const qty = Number(item.quantity);

    const inventory = await tx.storeInventory.upsert({
      where: { storeId_productId: { storeId: params.storeId, productId: item.productId } },
      update: { stockQuantity: { increment: qty } },
      create: { storeId: params.storeId, productId: item.productId, stockQuantity: qty },
    });

    const newStock = Number(inventory.stockQuantity);
    const prevStock = parseFloat((newStock - qty).toFixed(3));

    await tx.inventoryTransaction.create({
      data: {
        storeId: params.storeId,
        productId: item.productId,
        previousQuantity: prevStock,
        changeQuantity: qty,
        newQuantity: newStock,
        type: 'ORDER_CANCELLATION_RESTORE',
        reason: params.reason,
        performedByAdminId: params.performedByAdminId ?? null,
      },
    });
  }
}

/**
 * Locks a store inventory row for the rest of the transaction (no-op if it does not exist).
 */
export async function lockInventoryRow(tx: Tx, storeId: string, productId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 FROM "store_inventory"
    WHERE "store_id" = ${storeId}::uuid AND "product_id" = ${productId}::uuid
    FOR UPDATE
  `;
}

/**
 * Deducts `quantity` from a store's stock for checkout (P0-06 CAS) and logs an
 * ORDER_DEDUCTION transaction. Throws INSUFFICIENT_STOCK:<name>:<stock>:<unit>
 * when stock is missing/unavailable/too low, and 409 CONCURRENCY_ERROR when the
 * row changed between read and write.
 */
export async function deductStockForOrder(
  tx: Tx,
  params: { storeId: string; productId: string; quantity: number; productName: string; unit: string },
): Promise<void> {
  const { storeId, productId, quantity, productName, unit } = params;

  const currentInv = await tx.storeInventory.findUnique({
    where: { storeId_productId: { storeId, productId } },
  });
  const prevStock = currentInv ? Number(currentInv.stockQuantity) : 0;

  if (!currentInv || !currentInv.isAvailable || prevStock < quantity) {
    throw new Error(`INSUFFICIENT_STOCK:${productName}:${prevStock}:${unit}`);
  }

  const newStock = prevStock - quantity;
  const updateCount = await tx.storeInventory.updateMany({
    where: { storeId, productId, isAvailable: true, stockQuantity: prevStock }, // CAS check
    data: { stockQuantity: newStock },
  });
  if (updateCount.count === 0) {
    throw new AppError(409, 'CONCURRENCY_ERROR', 'Stock changed while placing the order. Please try again.');
  }

  await tx.inventoryTransaction.create({
    data: {
      storeId,
      productId,
      previousQuantity: prevStock,
      changeQuantity: -quantity,
      newQuantity: newStock,
      type: 'ORDER_DEDUCTION',
      reason: 'Checkout stock deduction',
    },
  });
}

export type StockAdjustmentType = 'STOCK_ADDED' | 'STOCK_REMOVED' | 'STOCK_ADJUSTED';

export interface StockAdjustmentInput {
  /** ADD / REMOVE / SET by `quantity` (admin adjustment UI). */
  adjustmentType?: 'ADD' | 'REMOVE' | 'SET';
  quantity?: number | null;
  /** Legacy signature: set stock to this value. */
  stockQuantity?: number | null;
}

/**
 * Pure stock arithmetic for a manual adjustment. Throws INVALID_QUANTITY when an
 * adjustment type has no quantity, and NEGATIVE_STOCK_BLOCKED when stock would go below 0.
 */
export function computeStockAdjustment(
  prevStock: number,
  input: StockAdjustmentInput,
): { newStock: number; change: number; type: StockAdjustmentType } {
  let newStock = prevStock;
  let type: StockAdjustmentType = 'STOCK_ADJUSTED';

  if (input.adjustmentType) {
    if (input.quantity == null) throw new AppError(400, 'INVALID_QUANTITY', 'Quantity must be a positive number.');
    const qty = input.quantity;
    if (input.adjustmentType === 'ADD') {
      newStock = prevStock + qty;
      type = 'STOCK_ADDED';
    } else if (input.adjustmentType === 'REMOVE') {
      newStock = prevStock - qty;
      type = 'STOCK_REMOVED';
    } else {
      newStock = qty;
    }
  } else if (input.stockQuantity != null) {
    newStock = input.stockQuantity;
  }

  if (newStock < 0) throw new Error('NEGATIVE_STOCK_BLOCKED');
  return { newStock, change: newStock - prevStock, type };
}

/**
 * Manual inventory update (admin/manager): locks the row (P0-06), applies the
 * adjustment, upserts threshold/availability, logs the inventory transaction and audit entry.
 */
export async function adjustStoreInventory(
  tx: Tx,
  params: StockAdjustmentInput & {
    storeId: string;
    productId: string;
    lowStockThreshold?: number | null;
    isAvailable?: boolean;
    reason?: string | null;
    adminUserId?: string;
  },
) {
  const { storeId, productId } = params;
  await lockInventoryRow(tx, storeId, productId);

  const currentInv = await tx.storeInventory.findUnique({ where: { storeId_productId: { storeId, productId } } });
  const prevStock = currentInv ? Number(currentInv.stockQuantity) : 0;
  const { newStock, change, type } = computeStockAdjustment(prevStock, params);

  const inventory = await tx.storeInventory.upsert({
    where: { storeId_productId: { storeId, productId } },
    update: {
      stockQuantity: newStock,
      lowStockThreshold: params.lowStockThreshold ?? undefined,
      isAvailable: params.isAvailable,
      updatedAt: new Date(),
    },
    create: {
      storeId,
      productId,
      stockQuantity: newStock,
      lowStockThreshold: params.lowStockThreshold ?? 5.0,
      isAvailable: params.isAvailable ?? true,
    },
  });

  if (change !== 0 || params.adjustmentType || params.stockQuantity != null) {
    await tx.inventoryTransaction.create({
      data: {
        storeId,
        productId,
        previousQuantity: prevStock,
        changeQuantity: change,
        newQuantity: newStock,
        type,
        reason: params.reason || 'Manual stock override',
        performedByAdminId: params.adminUserId,
      },
    });
  }

  await tx.auditLog.create({
    data: {
      adminUserId: params.adminUserId,
      action: 'UPDATE_INVENTORY',
      details: `Manual inventory adjust (${type}) for store ID: ${storeId}, product ID: ${productId}. Old: ${prevStock}, Change: ${change}, New: ${newStock}`,
    },
  });

  return inventory;
}
