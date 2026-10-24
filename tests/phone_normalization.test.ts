import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { normalizeIndianPhone } from '../src/utils/phone';

// D-008: India-only mobile numbers, stored as +91XXXXXXXXXX.
describe('Indian phone normalization (D-008)', () => {
  const canonical = '+919777700801';
  const other = '+919777700802';

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { phone: { in: [canonical, other] } } });
    await prisma.$disconnect();
  });

  describe('normalizeIndianPhone', () => {
    it.each([
      ['9876543210', '+919876543210'],
      ['+919876543210', '+919876543210'],
      ['919876543210', '+919876543210'],
      ['09876543210', '+919876543210'],
      ['+91 98765 43210', '+919876543210'],
      ['98765-43210', '+919876543210'],
      ['(+91) 98765.43210', '+919876543210'],
      ['  6000000000 ', '+916000000000'],
    ])('normalizes %p to %p', (input, expected) => {
      expect(normalizeIndianPhone(input)).toBe(expected);
    });

    it.each([
      ['5876543210'], // Indian mobiles start with 6-9
      ['987654321'], // 9 digits
      ['98765432101'], // 11 digits without leading 0
      ['+449876543210'], // non-Indian country code
      ['+4477009000001'],
      ['+9198765432'],
      ['phone'],
      [''],
      ['+91+9876543210'],
    ])('rejects %p', (input) => {
      expect(normalizeIndianPhone(input)).toBeNull();
    });

    it('rejects non-string input', () => {
      expect(normalizeIndianPhone(9876543210)).toBeNull();
      expect(normalizeIndianPhone(undefined)).toBeNull();
      expect(normalizeIndianPhone(null)).toBeNull();
    });
  });

  const sendOtp = (phone: unknown) => request(app).post('/api/v1/auth/send-otp').send({ phone });
  const verifyOtp = (phone: unknown, otp = '1234') => request(app).post('/api/v1/auth/verify-otp').send({ phone, otp });

  it('accepts a bare 10-digit mobile number and stores it as +91XXXXXXXXXX', async () => {
    expect((await sendOtp('9777700801')).statusCode).toEqual(200);
    const res = await verifyOtp('9777700801');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.user.phone).toBe(canonical);
    expect(await prisma.user.count({ where: { phone: canonical } })).toBe(1);
    expect(await prisma.user.count({ where: { phone: '9777700801' } })).toBe(0);
  });

  it('treats different input formats of the same number as one account', async () => {
    await sendOtp(canonical);
    const first = await verifyOtp(canonical);
    expect(first.statusCode).toEqual(200);
    await sendOtp('+91 97777-00801');
    const second = await verifyOtp('09777700801');

    expect(second.statusCode).toEqual(200);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(await prisma.user.count({ where: { phone: canonical } })).toBe(1);
  });

  it('shares OTP state across formats (OTP sent to 10-digit, verified with +91)', async () => {
    expect((await sendOtp('9777700802')).statusCode).toEqual(200);
    const res = await verifyOtp(other);
    expect(res.statusCode).toEqual(200);
    expect(res.body.data.user.phone).toBe(other);
  });

  it.each([['+447700900000'], ['5777700801'], ['12345'], ['not-a-phone']])(
    'rejects %p on send-otp with INVALID_PHONE_FORMAT',
    async (phone) => {
      const res = await sendOtp(phone);
      expect(res.statusCode).toEqual(400);
      expect(res.body.errorCode).toBe('INVALID_PHONE_FORMAT');
    },
  );

  it('rejects an invalid number on verify-otp with INVALID_PHONE_FORMAT', async () => {
    const res = await verifyOtp('+447700900000');
    expect(res.statusCode).toEqual(400);
    expect(res.body.errorCode).toBe('INVALID_PHONE_FORMAT');
  });

  it('still requires both phone and OTP on verify-otp', async () => {
    const res = await request(app).post('/api/v1/auth/verify-otp').send({ phone: '9777700801' });
    expect(res.statusCode).toEqual(400);
    expect(res.body.errorCode).toBe('MISSING_PARAMETERS');
  });
});
