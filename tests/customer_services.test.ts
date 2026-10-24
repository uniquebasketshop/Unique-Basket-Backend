import { Request } from 'express';
import { prisma } from '../src/config/db';
import { AppError } from '../src/utils/errors';
import { requireUserId } from '../src/utils/request';
import { getCustomerProfile } from '../src/services/customerService';
import { createAddress, deleteAddress, listAddresses, setDefaultAddress, updateAddress } from '../src/services/addressService';
import { addFavorite, listFavorites, removeFavorite } from '../src/services/favoriteService';
import { checkPincode } from '../src/services/serviceabilityService';

// P2-01: customer services used by the thin CustomerController.
describe('Customer services (P2-01)', () => {
  const phone = '+919777700903';
  let userId: string;
  let pincode: string;

  beforeAll(async () => {
    userId = (await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Service Customer' } })).id;
    pincode = (await prisma.supportedPincode.findFirstOrThrow({ where: { isActive: true } })).pincode;
  });

  afterAll(async () => {
    await prisma.favorite.deleteMany({ where: { userId } });
    await prisma.userAddress.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const expectAppError = async (promise: Promise<unknown>, status: number, errorCode: string) => {
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await promise.catch((e: AppError) => expect({ status: e.status, errorCode: e.errorCode }).toEqual({ status, errorCode }));
  };

  const defaults = async () => (await listAddresses(userId)).filter((a) => a.isDefault).map((a) => a.id);

  it('requireUserId throws 401 UNAUTHORIZED without an authenticated user', () => {
    expect(() => requireUserId({} as Request)).toThrow(AppError);
    expect(requireUserId({ user: { id: 'u1' } } as unknown as Request)).toBe('u1');
  });

  it('getCustomerProfile hides deactivated accounts', async () => {
    expect((await getCustomerProfile(userId)).phone).toBe(phone);
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    await expectAppError(getCustomerProfile(userId), 404, 'USER_NOT_FOUND');
    await prisma.user.update({ where: { id: userId }, data: { isActive: true } });
  });

  it('keeps exactly one default address through create, update, set-default and delete', async () => {
    const first = await createAddress(userId, { addressLine: '1 First St', pincode });
    expect(first.isDefault).toBe(true);
    expect(Number(first.latitude)).toBeCloseTo(22.3039); // existing fallback (P1-01)

    const second = await createAddress(userId, { addressLine: '2 Second St', pincode, isDefault: true });
    expect(await defaults()).toEqual([second.id]);

    await setDefaultAddress(userId, first.id);
    expect(await defaults()).toEqual([first.id]);

    await updateAddress(userId, second.id, { isDefault: true, title: 'Work' });
    expect(await defaults()).toEqual([second.id]);

    await deleteAddress(userId, second.id);
    expect(await defaults()).toEqual([first.id]);
  });

  it('rejects an unserviceable pincode without touching the current default', async () => {
    const [current] = await defaults();
    const other = await createAddress(userId, { addressLine: '3 Third St', pincode, isDefault: false });
    await expectAppError(updateAddress(userId, other.id, { isDefault: true, pincode: '000000' }), 400, 'PINCODE_NOT_SERVICEABLE');
    expect(await defaults()).toEqual([current]);
    await expectAppError(createAddress(userId, { addressLine: 'x', pincode: '000000', isDefault: true }), 400, 'PINCODE_NOT_SERVICEABLE');
    expect(await defaults()).toEqual([current]);
  });

  it('enforces address ownership', async () => {
    const [mine] = await defaults();
    await expectAppError(setDefaultAddress('00000000-0000-0000-0000-000000000000', mine), 404, 'ADDRESS_NOT_FOUND');
    await expectAppError(deleteAddress('00000000-0000-0000-0000-000000000000', mine), 404, 'ADDRESS_NOT_FOUND');
  });

  it('favourites are idempotent and require a product id', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { isActive: true } });
    await addFavorite(userId, product.id);
    await addFavorite(userId, product.id);
    expect((await listFavorites(userId)).productIds).toEqual([product.id]);
    await removeFavorite(userId, product.id);
    await removeFavorite(userId, product.id);
    expect((await listFavorites(userId)).productIds).toEqual([]);
    await expectAppError(addFavorite(userId, undefined), 400, 'MISSING_PRODUCT_ID');
  });

  it('checkPincode reports serviceability', async () => {
    expect(await checkPincode(pincode)).toMatchObject({ isServiceable: true, pincode });
    expect(await checkPincode('000000')).toMatchObject({ isServiceable: false, pincode: '000000' });
  });
});
