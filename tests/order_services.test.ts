import { calculateOrderCharges } from '../src/services/orderService';
import { computeStockAdjustment } from '../src/services/inventoryService';
import { FareSettings } from '../src/services/pricingService';
import { toPaise } from '../src/utils/money';

// P2-01: business rules extracted from controllers are testable without HTTP or a database.
const fares: FareSettings = {
  deliveryEnabled: true,
  deliveryFee: 30,
  freeDeliveryThreshold: 200,
  minimumOrderAmount: 199,
  codEnabled: true,
  codCharge: 20,
  minimumCodOrderAmount: 100,
  maximumCodOrderAmount: 5000,
  pickupCodEnabled: true,
};

describe('calculateOrderCharges', () => {
  it('charges delivery below the free threshold and COD charge for COD', () => {
    expect(calculateOrderCharges(fares, 'DELIVERY', 'COD', toPaise(199.5))).toEqual({
      subtotal: 199.5,
      deliveryFee: 30,
      codCharge: 20,
      total: 249.5,
    });
  });

  it('waives delivery from the threshold and adds no COD charge for ONLINE', () => {
    expect(calculateOrderCharges(fares, 'DELIVERY', 'ONLINE', toPaise(200))).toEqual({
      subtotal: 200,
      deliveryFee: 0,
      codCharge: 0,
      total: 200,
    });
  });

  it('never charges delivery for pickup and ignores the delivery minimum', () => {
    expect(calculateOrderCharges(fares, 'PICKUP', 'COD', toPaise(150))).toMatchObject({ deliveryFee: 0, total: 150 });
  });

  it.each([50, 150, 6000])('pay at store has no COD charge and no COD limits (D-018): subtotal %d', (subtotal) => {
    expect(calculateOrderCharges(fares, 'PICKUP', 'COD', toPaise(subtotal))).toEqual({
      subtotal,
      deliveryFee: 0,
      codCharge: 0,
      total: subtotal,
    });
  });

  it('Pay at Store is never switched off by the COD settings (D-018)', () => {
    const allOff = { ...fares, codEnabled: false, pickupCodEnabled: false };
    expect(calculateOrderCharges(allOff, 'PICKUP', 'COD', toPaise(300))).toEqual({
      subtotal: 300,
      deliveryFee: 0,
      codCharge: 0,
      total: 300,
    });
  });

  it('keeps exact paise totals', () => {
    expect(calculateOrderCharges(fares, 'DELIVERY', 'COD', toPaise(199.99)).total).toBe(249.99);
  });

  it.each([
    [{ ...fares }, 'DELIVERY', 'ONLINE', 150, 'MINIMUM_DELIVERY_AMOUNT_NOT_MET:199'],
    [{ ...fares, codEnabled: false }, 'DELIVERY', 'COD', 300, 'COD_DISABLED'],
    [{ ...fares, minimumOrderAmount: 0 }, 'DELIVERY', 'COD', 50, 'MINIMUM_COD_AMOUNT_NOT_MET:100'],
    [{ ...fares }, 'DELIVERY', 'COD', 6000, 'MAXIMUM_COD_AMOUNT_EXCEEDED:5000'],
  ] as const)('rejects with the existing error token (%#)', (settings, fulfillment, payment, subtotal, message) => {
    expect(() => calculateOrderCharges(settings, fulfillment, payment, toPaise(subtotal))).toThrow(message);
  });
});

describe('computeStockAdjustment', () => {
  it('applies ADD, REMOVE and SET', () => {
    expect(computeStockAdjustment(10, { adjustmentType: 'ADD', quantity: 2.5 })).toEqual({ newStock: 12.5, change: 2.5, type: 'STOCK_ADDED' });
    expect(computeStockAdjustment(10, { adjustmentType: 'REMOVE', quantity: 4 })).toEqual({ newStock: 6, change: -4, type: 'STOCK_REMOVED' });
    expect(computeStockAdjustment(10, { adjustmentType: 'SET', quantity: 3 })).toEqual({ newStock: 3, change: -7, type: 'STOCK_ADJUSTED' });
  });

  it('supports the legacy stockQuantity override and threshold-only updates', () => {
    expect(computeStockAdjustment(10, { stockQuantity: 25 })).toEqual({ newStock: 25, change: 15, type: 'STOCK_ADJUSTED' });
    expect(computeStockAdjustment(10, {})).toEqual({ newStock: 10, change: 0, type: 'STOCK_ADJUSTED' });
  });

  it('blocks negative stock and missing adjustment quantities', () => {
    expect(() => computeStockAdjustment(3, { adjustmentType: 'REMOVE', quantity: 4 })).toThrow('NEGATIVE_STOCK_BLOCKED');
    expect(() => computeStockAdjustment(3, { stockQuantity: -1 })).toThrow('NEGATIVE_STOCK_BLOCKED');
    expect(() => computeStockAdjustment(3, { adjustmentType: 'ADD' })).toThrow('Quantity must be a positive number.');
  });
});
