import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { OtpService, OTP_LENGTH, isOtpBypassEnabled } from '../src/services/otpService';

describe('OTP bypass guard (P0-01)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypassFlag = process.env.OTP_BYPASS_ENABLED;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.OTP_BYPASS_ENABLED = originalBypassFlag;
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const otpWasLogged = () =>
    logSpy.mock.calls.some((args) => String(args[0]).includes('[SMS-MOCK]'));

  describe('isOtpBypassEnabled', () => {
    it('is enabled only for explicit development or test', () => {
      process.env.NODE_ENV = 'development';
      expect(isOtpBypassEnabled()).toBe(true);
      process.env.NODE_ENV = 'test';
      expect(isOtpBypassEnabled()).toBe(true);
    });

    it('is disabled in development/test unless OTP_BYPASS_ENABLED is exactly "true"', () => {
      for (const env of ['development', 'test']) {
        process.env.NODE_ENV = env;
        delete process.env.OTP_BYPASS_ENABLED;
        expect(isOtpBypassEnabled()).toBe(false);
        process.env.OTP_BYPASS_ENABLED = 'false';
        expect(isOtpBypassEnabled()).toBe(false);
        process.env.OTP_BYPASS_ENABLED = '1';
        expect(isOtpBypassEnabled()).toBe(false);
      }
    });

    it('is disabled outside development/test even when OTP_BYPASS_ENABLED=true', () => {
      process.env.OTP_BYPASS_ENABLED = 'true';
      delete process.env.NODE_ENV;
      expect(isOtpBypassEnabled()).toBe(false);
      process.env.NODE_ENV = 'production';
      expect(isOtpBypassEnabled()).toBe(false);
    });

    it('does not accept the static OTP in development without the flag', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.OTP_BYPASS_ENABLED;
      const phone = '+919000000301';
      const result = await OtpService.sendOtp(phone);

      expect(result.success).toBe(true);
      expect(result.otp).toBeUndefined();
      expect(otpWasLogged()).toBe(false);
      expect((await OtpService.verifyOtp(phone, '1234')).success).toBe(false);
    });

    it('is disabled when NODE_ENV is missing, production, or anything else', () => {
      delete process.env.NODE_ENV;
      expect(isOtpBypassEnabled()).toBe(false);
      process.env.NODE_ENV = 'production';
      expect(isOtpBypassEnabled()).toBe(false);
      process.env.NODE_ENV = 'staging';
      expect(isOtpBypassEnabled()).toBe(false);
    });
  });

  describe('OTP length (D-004)', () => {
    it('uses OTP_LENGTH = 4', () => {
      expect(OTP_LENGTH).toBe(4);
    });

    it('generates a zero-padded 4-digit OTP from crypto.randomInt when the bypass is disabled', async () => {
      process.env.NODE_ENV = 'production';
      const randomIntMock = jest.fn().mockReturnValue(42);

      await jest.isolateModulesAsync(async () => {
        jest.doMock('crypto', () => ({ ...jest.requireActual('crypto'), randomInt: randomIntMock }));
        const { OtpService: IsolatedOtpService } = await import('../src/services/otpService');
        const phone = '+919000000201';

        await IsolatedOtpService.sendOtp(phone);
        expect(randomIntMock).toHaveBeenCalledWith(0, 10000);

        const verify = await IsolatedOtpService.verifyOtp(phone, '0042');
        expect(verify.success).toBe(true);
      });
      jest.dontMock('crypto');
    });
  });

  describe('OtpService.sendOtp', () => {
    it('does not use the static OTP, return it, or log it when NODE_ENV is missing', async () => {
      delete process.env.NODE_ENV;
      const phone = '+919000000101';
      const result = await OtpService.sendOtp(phone);

      expect(result.success).toBe(true);
      expect(result.otp).toBeUndefined();
      expect(otpWasLogged()).toBe(false);

      // Static development OTP must not verify
      const verify = await OtpService.verifyOtp(phone, '1234');
      expect(verify.success).toBe(false);
    });

    it('does not use the static OTP, return it, or log it in production', async () => {
      process.env.NODE_ENV = 'production';
      const phone = '+919000000102';
      const result = await OtpService.sendOtp(phone);

      expect(result.success).toBe(true);
      expect(result.otp).toBeUndefined();
      expect(otpWasLogged()).toBe(false);

      const verify = await OtpService.verifyOtp(phone, '1234');
      expect(verify.success).toBe(false);
    });

    it('keeps the static 1234 bypass in development', async () => {
      process.env.NODE_ENV = 'development';
      const phone = '+919000000103';
      const result = await OtpService.sendOtp(phone);

      expect(result.otp).toBe('1234');
      expect(otpWasLogged()).toBe(true);

      const verify = await OtpService.verifyOtp(phone, '1234');
      expect(verify.success).toBe(true);
    });
  });

  describe('POST /api/v1/auth/send-otp', () => {
    it('does not include the OTP in the response when NODE_ENV is missing', async () => {
      delete process.env.NODE_ENV;
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '+919000000104' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body).not.toHaveProperty('otp');
    });

    it('does not include the OTP in the response in production', async () => {
      process.env.NODE_ENV = 'production';
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '+919000000105' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).not.toHaveProperty('otp');
    });

    it('still includes the OTP in the response in test', async () => {
      process.env.NODE_ENV = 'test';
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '+919000000106' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.otp).toBe('1234');
    });
  });
});
