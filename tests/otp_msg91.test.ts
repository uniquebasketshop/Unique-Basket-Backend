import request from 'supertest';
import app from '../src/app';
import { OtpService } from '../src/services/otpService';
import { getMsg91Config, sendOtpSms } from '../src/services/sms/msg91Client';

// P-003: login OTPs are delivered by MSG91; the backend still generates and verifies them.
describe('Login OTP SMS via MSG91', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    OTP_BYPASS_ENABLED: process.env.OTP_BYPASS_ENABLED,
    MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
    MSG91_OTP_TEMPLATE_ID: process.env.MSG91_OTP_TEMPLATE_ID,
  };
  let seq = 0;
  const phone = () => `+9197700${String(Date.now()).slice(-3)}${String(seq++).padStart(2, '0')}`;

  /** Fake MSG91: answers with [body]; records the requests. */
  const fakeMsg91 = (body: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return { impl, calls };
  };

  beforeEach(() => {
    // Real-OTP mode: no static 1234, MSG91 configured
    process.env.NODE_ENV = 'test';
    process.env.OTP_BYPASS_ENABLED = 'false';
    process.env.MSG91_AUTH_KEY = 'test-auth-key';
    process.env.MSG91_OTP_TEMPLATE_ID = 'tmpl-123';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  it('sends the backend\'s 4-digit OTP to MSG91 (91XXXXXXXXXX, template, auth key in a header), and that OTP logs in', async () => {
    const { impl, calls } = fakeMsg91({ type: 'success', request_id: 'r1' });
    const log = jest.spyOn(console, 'log');
    const p = phone();

    const res = await OtpService.sendOtp(p, impl);

    expect(res).toEqual({ success: true, message: 'OTP sent successfully.' }); // never returned to the client
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://control.msg91.com/api/v5/otp');
    expect(url.searchParams.get('mobile')).toBe(p.slice(1));
    expect(url.searchParams.get('template_id')).toBe('tmpl-123');
    const otp = url.searchParams.get('otp')!;
    expect(otp).toMatch(/^\d{4}$/);
    expect(url.searchParams.get('otp_length')).toBe('4');
    expect((calls[0].init.headers as Record<string, string>).authkey).toBe('test-auth-key');
    expect(url.toString()).not.toContain('test-auth-key');
    expect(log.mock.calls.flat().join(' ')).not.toContain(otp);

    expect(await OtpService.verifyOtp(p, otp)).toMatchObject({ success: true });
  });

  it('MSG91 refusing the message (HTTP 200 with type "error") fails without using up a request', async () => {
    const p = phone();
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await OtpService.sendOtp(p, fakeMsg91({ type: 'error', message: 'Invalid template' }).impl);
    expect(refused).toMatchObject({ success: false, errorCode: 'OTP_SEND_FAILED' });
    expect(errorLog.mock.calls.flat().join(' ')).toContain('Invalid template');
    expect(await OtpService.verifyOtp(p, '0000')).toMatchObject({ success: false, message: 'No OTP requested for this phone number.' });

    // Not counted: the customer can retry straight away
    const { impl } = fakeMsg91({ type: 'success' });
    expect(await OtpService.sendOtp(p, impl)).toMatchObject({ success: true });
  });

  it('a network failure or HTTP error is reported as not sent', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = getMsg91Config()!;
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    expect(await sendOtpSms(config, '+919876543210', '1234', down)).toBe(false);
    expect(await sendOtpSms(config, '+919876543210', '1234', fakeMsg91({ type: 'success' }, 401).impl)).toBe(false);
  });

  it('POST /auth/send-otp answers 503 OTP_SEND_FAILED when MSG91 is down', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ type: 'error', message: 'down' }), { status: 500 }));
    const res = await request(app).post('/api/v1/auth/send-otp').send({ phone: phone() });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false, errorCode: 'OTP_SEND_FAILED' });
  });

  it('with the static test OTP on, MSG91 is never called', async () => {
    process.env.OTP_BYPASS_ENABLED = 'true';
    const { impl, calls } = fakeMsg91({ type: 'success' });
    const res = await OtpService.sendOtp(phone(), impl);
    expect(res).toMatchObject({ success: true, otp: '1234' });
    expect(calls).toHaveLength(0);
  });

  it('without MSG91 keys (local development), nothing is sent', async () => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_OTP_TEMPLATE_ID;
    expect(getMsg91Config()).toBeNull();
    const { impl, calls } = fakeMsg91({ type: 'success' });
    expect(await OtpService.sendOtp(phone(), impl)).toMatchObject({ success: true });
    expect(calls).toHaveLength(0);
  });
});
