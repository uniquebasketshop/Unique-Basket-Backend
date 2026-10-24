import { OtpService } from '../src/services/otpService';

/**
 * Daily OTP cap per phone: with a 4-digit OTP (D-004) the hourly limit alone still allows
 * ~300 guesses a day on one number, so at most 10 OTPs are sent per phone per 24 hours.
 */
describe('OTP daily limit per phone', () => {
  const start = new Date('2026-10-11T08:00:00.000Z');
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: start });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
  });

  const advance = (ms: number) => jest.setSystemTime(new Date(Date.now() + ms));
  const HOUR = 60 * 60 * 1000;

  /** Sends `count` OTPs, waiting 2 hours after every 5 so the hourly limit never applies. */
  const sendSpread = async (phone: string, count: number) => {
    const results = [];
    for (let i = 0; i < count; i++) {
      if (i > 0 && i % 5 === 0) advance(2 * HOUR);
      results.push(await OtpService.sendOtp(phone));
    }
    return results;
  };

  it('allows 10 OTPs in 24 hours, then refuses until the window has passed', async () => {
    const phone = '+919000000401';

    const results = await sendSpread(phone, 10);
    expect(results.every((r) => r.success)).toBe(true);

    advance(2 * HOUR);
    const eleventh = await OtpService.sendOtp(phone);
    expect(eleventh.success).toBe(false);
    expect(eleventh.message).toMatch(/today/);

    // 24 hours after the first OTP of the window
    jest.setSystemTime(new Date(start.getTime() + 24 * HOUR + 1000));
    const nextDay = await OtpService.sendOtp(phone);
    expect(nextDay.success).toBe(true);
  });

  it('counts each phone separately', async () => {
    const results = await sendSpread('+919000000402', 10);
    expect(results.every((r) => r.success)).toBe(true);

    expect((await OtpService.sendOtp('+919000000403')).success).toBe(true);
  });

  it('a refused request does not issue a new OTP', async () => {
    const phone = '+919000000404';
    await sendSpread(phone, 10);
    advance(2 * HOUR);

    const refused = await OtpService.sendOtp(phone);
    expect(refused.success).toBe(false);
    expect(refused.otp).toBeUndefined();
  });
});
