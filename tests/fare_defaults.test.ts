import { prisma } from '../src/config/db';
import { calculateDeliveryFee, loadFareSettings } from '../src/services/pricingService';

// D-009: confirmed delivery/COD values.
describe('Confirmed fare defaults (D-009)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const fakeDb = { deliverySettings: { findFirst: async () => null } } as any;

  it('uses the confirmed values when no settings row exists', async () => {
    expect(await loadFareSettings(fakeDb)).toMatchObject({
      deliveryFee: 30,
      freeDeliveryThreshold: 200,
      minimumOrderAmount: 199,
      codCharge: 20,
      minimumCodOrderAmount: 100,
      maximumCodOrderAmount: 5000,
    });
  });

  it('charges ₹30 below ₹200 and waives it from ₹200', async () => {
    const settings = await loadFareSettings(fakeDb);
    expect(calculateDeliveryFee(199, settings)).toBe(30);
    expect(calculateDeliveryFee(199.99, settings)).toBe(30);
    expect(calculateDeliveryFee(200, settings)).toBe(0);
    expect(calculateDeliveryFee(540, settings)).toBe(0);
  });

  it('seeds the confirmed values into the database', async () => {
    const row = await prisma.deliverySettings.findFirst();
    expect(row).not.toBeNull();
    expect(Number(row!.deliveryFee)).toBe(30);
    expect(Number(row!.freeDeliveryThreshold)).toBe(200);
    expect(Number(row!.minimumOrderAmount)).toBe(199);
    expect(Number(row!.codCharge)).toBe(20);
    expect(Number(row!.minimumCodOrderAmount)).toBe(100);
    expect(Number(row!.maximumCodOrderAmount)).toBe(5000);
  });
});
