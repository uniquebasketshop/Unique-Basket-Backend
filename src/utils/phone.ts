/**
 * Indian mobile numbers only (owner decision D-008).
 * Canonical stored form: +91 followed by the 10-digit mobile number, e.g. +919876543210.
 */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Normalizes user input to `+91XXXXXXXXXX`, or returns null when it is not a valid
 * Indian mobile number. Accepts `9876543210`, `+919876543210`, `919876543210`,
 * `09876543210`, with optional spaces, hyphens, dots or parentheses.
 */
export function normalizeIndianPhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits: string;
  if (compact.startsWith('+')) {
    if (!compact.startsWith('+91')) return null;
    digits = compact.slice(3);
  } else if (compact.length === 12 && compact.startsWith('91')) {
    digits = compact.slice(2);
  } else if (compact.length === 11 && compact.startsWith('0')) {
    digits = compact.slice(1);
  } else {
    digits = compact;
  }

  return INDIAN_MOBILE.test(digits) ? `+91${digits}` : null;
}
