import { randomInt } from 'crypto';
import { getMsg91Config, sendOtpSms } from './sms/msg91Client';

interface OtpRecord {
  otp: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
  requestCount: number;
  blockUntil?: Date;
  /** Start of the current 24-hour window and OTPs sent in it (daily cap per phone). */
  dayWindowStart: Date;
  dayCount: number;
}

const otpStore = new Map<string, OtpRecord>();

// Config constants
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute
const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_REQUESTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
// With a 4-digit OTP the hourly limit alone still allows ~300 guesses a day on one number.
const MAX_REQUESTS_PER_DAY = 10;
const DAY_MS = 24 * HOUR_MS;
export const OTP_LENGTH = 4; // Project decision D-004: 4-digit OTP in all environments

/**
 * Static OTP bypass is a temporary workaround until a real OTP provider is chosen.
 * Enabled ONLY when NODE_ENV is explicitly 'development' or 'test' AND OTP_BYPASS_ENABLED=true,
 * so a server that is only mis-set to NODE_ENV=development still sends real OTPs.
 * A missing or any other NODE_ENV is treated as production.
 */
export function isOtpBypassEnabled(): boolean {
  const devOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  return devOrTest && process.env.OTP_BYPASS_ENABLED === 'true';
}

export class OtpService {
  /**
   * Generates and logs OTP for the given phone number, enforcing rate limits.
   */
  static async sendOtp(
    phone: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ success: boolean; message: string; otp?: string; errorCode?: string }> {
    const now = new Date();
    let record = otpStore.get(phone);

    // Check if the phone number is blocked
    if (record?.blockUntil && record.blockUntil > now) {
      const minutesLeft = Math.ceil((record.blockUntil.getTime() - now.getTime()) / 60000);
      return {
        success: false,
        message: `Too many attempts. Please try again after ${minutesLeft} minute(s).`,
      };
    }

    // Daily cap per phone (rolling 24 hours from the first OTP of the window)
    const dayWindowActive = record !== undefined && now.getTime() - record.dayWindowStart.getTime() < DAY_MS;
    if (record && dayWindowActive && record.dayCount >= MAX_REQUESTS_PER_DAY) {
      return {
        success: false,
        message: 'Too many OTP requests for this number today. Please try again tomorrow.',
      };
    }

    if (record) {
      // Enforce resend cooldown (1 minute) - in test env allow immediate resend if needed
      const elapsed = now.getTime() - record.lastSentAt.getTime();
      if (elapsed < RESEND_COOLDOWN_MS && process.env.NODE_ENV !== 'test') {
        const secondsLeft = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        return {
          success: false,
          message: `Please wait ${secondsLeft} second(s) before requesting another OTP.`,
        };
      }

      // Enforce request count rate limit (reset requests if last sent was > 1 hour ago)
      const sinceFirstRequest = now.getTime() - record.lastSentAt.getTime();
      if (sinceFirstRequest > HOUR_MS) {
        record.requestCount = 0;
      }

      if (record.requestCount >= MAX_REQUESTS_PER_HOUR) {
        record.blockUntil = new Date(now.getTime() + 15 * 60 * 1000); // block for 15 mins
        otpStore.set(phone, record);
        return {
          success: false,
          message: 'Max OTP requests exceeded. Account temporarily blocked for 15 minutes.',
        };
      }
    }

    // Generate OTP (Temporary development workaround: static '1234')
    const isDevOrTest = isOtpBypassEnabled();
    const generatedOtp = isDevOrTest
      ? '1234'
      : randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');

    // Log the OTP only in development/test (never in production)
    if (isDevOrTest) {
      console.log(`[SMS-MOCK] OTP for ${phone} is: ${generatedOtp}`);
    }

    // Update/create store entry
    const previous = record;
    otpStore.set(phone, {
      otp: generatedOtp,
      expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
      lastSentAt: now,
      attempts: 0,
      requestCount: record ? record.requestCount + 1 : 1,
      dayWindowStart: record && dayWindowActive ? record.dayWindowStart : now,
      dayCount: record && dayWindowActive ? record.dayCount + 1 : 1,
    });

    // Real SMS via MSG91 (P-003) whenever it is configured and the static test OTP is off.
    // Production refuses to start without it (validateEnv). A failed send is not counted,
    // so the customer can simply try again.
    const msg91 = isDevOrTest ? null : getMsg91Config();
    if (msg91 && !(await sendOtpSms(msg91, phone, generatedOtp, fetchImpl))) {
      if (previous) otpStore.set(phone, previous);
      else otpStore.delete(phone);
      return {
        success: false,
        message: 'Could not send the OTP right now. Please try again in a minute.',
        errorCode: 'OTP_SEND_FAILED',
      };
    }

    return {
      success: true,
      message: 'OTP sent successfully.',
      ...(isDevOrTest ? { otp: generatedOtp } : {}),
    };
  }

  /**
   * Verifies the provided OTP for the phone number.
   */
  static async verifyOtp(phone: string, userOtp: string): Promise<{ success: boolean; message: string }> {
    const now = new Date();
    const record = otpStore.get(phone);

    if (!record) {
      return { success: false, message: 'No OTP requested for this phone number.' };
    }

    // Check expiry
    if (record.expiresAt <= now || !record.otp) {
      // Keep the record (rate-limit counters); the code itself is no longer usable.
      record.otp = '';
      otpStore.set(phone, record);
      return { success: false, message: 'OTP has expired. Please request a new one.' };
    }

    // Check block list status
    if (record.blockUntil && record.blockUntil > now) {
      return { success: false, message: 'Account is temporarily blocked due to excessive requests.' };
    }

    // Verify OTP match
    if (record.otp !== userOtp) {
      record.attempts += 1;
      if (record.attempts >= MAX_VERIFICATION_ATTEMPTS) {
        // Invalidate the code but keep the record so the per-phone request count, block and
        // resend cooldown still apply (deleting it reset them and allowed brute force).
        record.otp = '';
        record.expiresAt = now;
        otpStore.set(phone, record);
        return {
          success: false,
          message: 'Maximum verification attempts exceeded. Please request a new OTP.',
        };
      }
      otpStore.set(phone, record);
      const attemptsLeft = MAX_VERIFICATION_ATTEMPTS - record.attempts;
      return {
        success: false,
        message: `Invalid OTP. ${attemptsLeft} attempt(s) remaining.`,
      };
    }

    // Success: remove OTP record
    otpStore.delete(phone);
    return { success: true, message: 'OTP verified successfully.' };
  }
}
