import { OrderStatus, PaymentStatus } from '@prisma/client';
import { AppError } from '../src/utils/errors';
import {
  assertStatusTransition,
  assertStoreAccess,
  buildAdminOrderFilter,
  VALID_TRANSITIONS,
} from '../src/services/adminOrderService';

// P2-01: admin order rules are pure and testable without HTTP or a database.
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).errorCode;
  }
};

const order = (overrides: Partial<Parameters<typeof assertStatusTransition>[0]> = {}) => ({
  orderStatus: OrderStatus.PLACED,
  fulfillmentType: 'DELIVERY',
  paymentMethod: 'COD',
  paymentStatus: PaymentStatus.PENDING,
  ...overrides,
});

describe('assertStatusTransition', () => {
  it('allows the configured forward transitions and same-status no-ops', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        if (to === OrderStatus.PICKED_UP) continue; // only via pickup verification
        const fulfillmentType = to === OrderStatus.READY_FOR_PICKUP ? 'PICKUP' : 'DELIVERY';
        expect(codeOf(() => assertStatusTransition(order({ orderStatus: from as OrderStatus, fulfillmentType }), to))).toBeNull();
      }
    }
    expect(codeOf(() => assertStatusTransition(order({ orderStatus: OrderStatus.DELIVERED }), OrderStatus.DELIVERED))).toBeNull();
  });

  it('rejects transitions outside the table', () => {
    expect(codeOf(() => assertStatusTransition(order(), OrderStatus.DELIVERED))).toBe('INVALID_STATUS_TRANSITION');
    expect(codeOf(() => assertStatusTransition(order({ orderStatus: OrderStatus.CANCELLED }), OrderStatus.CONFIRMED))).toBe(
      'INVALID_STATUS_TRANSITION',
    );
  });

  it('PICKED_UP only via pickup verification (D-006)', () => {
    expect(
      codeOf(() => assertStatusTransition(order({ orderStatus: OrderStatus.READY_FOR_PICKUP, fulfillmentType: 'PICKUP' }), OrderStatus.PICKED_UP)),
    ).toBe('PICKUP_VERIFICATION_REQUIRED');
  });

  it('delivery-only statuses are invalid for PICKUP orders', () => {
    expect(
      codeOf(() => assertStatusTransition(order({ orderStatus: OrderStatus.PREPARING, fulfillmentType: 'PICKUP' }), OrderStatus.OUT_FOR_DELIVERY)),
    ).toBe('INVALID_STATUS_FOR_FULFILLMENT');
  });

  it('unpaid ONLINE orders can only be cancelled (D-005)', () => {
    const unpaidOnline = order({ paymentMethod: 'ONLINE', paymentStatus: PaymentStatus.PENDING });
    expect(codeOf(() => assertStatusTransition(unpaidOnline, OrderStatus.CONFIRMED))).toBe('ONLINE_PAYMENT_PENDING');
    expect(codeOf(() => assertStatusTransition(unpaidOnline, OrderStatus.CANCELLED))).toBeNull();
    expect(codeOf(() => assertStatusTransition({ ...unpaidOnline, paymentStatus: PaymentStatus.PAID }, OrderStatus.CONFIRMED))).toBeNull();
  });
});

describe('store isolation', () => {
  const manager = { role: 'STORE_MANAGER', storeId: 'store-a' };
  const admin = { role: 'SUPER_ADMIN' };

  it('assertStoreAccess blocks managers from other stores only', () => {
    expect(codeOf(() => assertStoreAccess(manager, 'store-b', 'x'))).toBe('STORE_ACCESS_FORBIDDEN');
    expect(codeOf(() => assertStoreAccess(manager, 'store-a', 'x'))).toBeNull();
    expect(codeOf(() => assertStoreAccess(admin, 'store-b', 'x'))).toBeNull();
  });

  it('a manager cannot widen the order list to another store', () => {
    expect(buildAdminOrderFilter(manager, { storeId: 'store-b' }).storeId).toBe('store-a');
    expect(buildAdminOrderFilter(admin, { storeId: 'store-b' }).storeId).toBe('store-b');
    expect(buildAdminOrderFilter(admin, {}).storeId).toBeUndefined();
  });

  it('validates the payment status filter and builds search conditions', () => {
    expect(codeOf(() => buildAdminOrderFilter(admin, { paymentStatus: 'REVERSED' }))).toBe('INVALID_PAYMENT_STATUS');
    expect(buildAdminOrderFilter(admin, { paymentStatus: 'REFUNDED' })).toMatchObject({ paymentStatus: 'REFUNDED' });
    const where = buildAdminOrderFilter(admin, { search: '  UB-01 ', paymentStatus: 'PAID', status: 'PLACED' });
    expect(where).toMatchObject({ paymentStatus: 'PAID', orderStatus: 'PLACED' });
    expect(where.OR).toHaveLength(3);
  });
});
