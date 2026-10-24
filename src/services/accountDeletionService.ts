import { OrderStatus, Prisma, RefundStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';
import { deletedPhoneFor } from '../utils/deletedAccount';

/** Orders in these states are finished; anything else is still in progress. */
const FINISHED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.PICKED_UP, OrderStatus.CANCELLED];

/**
 * Customer deletes their own account (App Store / Play requirement).
 *
 * Orders are kept for the store's accounts, but everything that identifies the person is removed:
 * name, email, birthday, gender, avatar, phone (replaced by a placeholder so the number can sign up
 * again as a new account), saved addresses, cart, favourites, notifications, device tokens and
 * sessions. Each order's address copy is cut down to city, state and pincode.
 *
 * Refused while an order is still in progress or a refund is still owed, so delivery and money
 * never depend on a deleted account.
 */
export async function deleteCustomerAccount(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Lock the row so two delete requests (or a delete and a profile update) cannot interleave.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true } });
    if (!user || !user.isActive) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Customer not found or account is deactivated.');
    }

    const openOrders = await tx.order.count({
      where: { userId, orderStatus: { notIn: FINISHED_ORDER_STATUSES } },
    });
    if (openOrders > 0) {
      throw new AppError(
        409,
        'ACCOUNT_HAS_ACTIVE_ORDERS',
        'You have an order in progress. You can delete your account once it is delivered or cancelled.',
      );
    }

    const refundsOwed = await tx.refund.count({
      where: { order: { userId }, status: { in: [RefundStatus.PENDING, RefundStatus.FAILED] } },
    });
    if (refundsOwed > 0) {
      throw new AppError(
        409,
        'ACCOUNT_HAS_PENDING_REFUND',
        'A refund is still being processed for one of your orders. You can delete your account once it is complete.',
      );
    }

    const orders = await tx.order.findMany({
      where: { userId },
      select: { id: true, deliveryAddressSnapshot: true },
    });
    for (const order of orders) {
      const snapshot = order.deliveryAddressSnapshot as Record<string, unknown> | null;
      await tx.order.update({
        where: { id: order.id },
        data: {
          idempotencyKey: null,
          deliveryAddressSnapshot: snapshot
            ? { city: snapshot.city ?? null, state: snapshot.state ?? null, pincode: snapshot.pincode ?? null }
            : Prisma.DbNull,
        },
      });
    }

    // Deleting the addresses also clears orders.address_id (ON DELETE SET NULL).
    await tx.userAddress.deleteMany({ where: { userId } });
    await tx.cartItem.deleteMany({ where: { userId } });
    await tx.favorite.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });

    await tx.user.update({
      where: { id: userId },
      data: {
        phone: deletedPhoneFor(userId),
        name: null,
        email: null,
        dob: null,
        gender: null,
        avatarId: null,
        isActive: false,
      },
    });

    await tx.auditLog.create({
      data: {
        adminUserId: null,
        action: 'CUSTOMER_ACCOUNT_DELETED',
        details: `Customer ${userId} deleted their account in the app. Orders kept (${orders.length}); personal data removed.`,
      },
    });
  });
}
