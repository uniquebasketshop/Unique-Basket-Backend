/**
 * MSG91 SMS delivery for login OTPs (P-003: MSG91). No SDK: one HTTPS call.
 *
 * The backend generates and verifies the OTP itself (limits, expiry, attempts in otpService);
 * MSG91 only delivers it, using the DLT-approved OTP template (its text contains ##OTP##).
 * Keys only in the server's .env: MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID.
 */
const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const TIMEOUT_MS = 8000;

export interface Msg91Config {
  authKey: string;
  templateId: string;
}

/** The MSG91 settings, or null when SMS is not configured (dev/test without keys). */
export function getMsg91Config(): Msg91Config | null {
  const authKey = process.env.MSG91_AUTH_KEY?.trim();
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID?.trim();
  return authKey && templateId ? { authKey, templateId } : null;
}

/**
 * Sends [otp] to [phone] ("+91XXXXXXXXXX"). Resolves true only when MSG91 accepted it.
 * Never logs the OTP or the auth key.
 */
export async function sendOtpSms(config: Msg91Config, phone: string, otp: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const params = new URLSearchParams({
    template_id: config.templateId,
    mobile: phone.replace(/^\+/, ''), // MSG91 wants 91XXXXXXXXXX
    otp,
    otp_length: String(otp.length),
  });
  try {
    const res = await fetchImpl(`${MSG91_OTP_URL}?${params}`, {
      method: 'POST',
      headers: { authkey: config.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // MSG91 can answer HTTP 200 with { type: "error" }: the body decides.
    const body = (await res.json().catch(() => null)) as { type?: string; message?: string } | null;
    if (res.ok && body?.type === 'success') return true;
    console.error(`[msg91] OTP SMS not sent (HTTP ${res.status}): ${body?.message ?? 'no details'}`);
    return false;
  } catch (error) {
    console.error('[msg91] OTP SMS request failed:', error instanceof Error ? error.message : error);
    return false;
  }
}
