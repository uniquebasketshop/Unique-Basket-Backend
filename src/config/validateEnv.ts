/**
 * Centralised validation for security-critical environment variables.
 * There are intentionally NO fallback values for secrets.
 */

const MIN_PRODUCTION_SECRET_LENGTH = 32;

// Values that must never be accepted as secrets (previous hard-coded fallbacks).
const KNOWN_INSECURE_SECRETS = ['fallback_access_secret', 'fallback_refresh_secret', 'secret'];

/**
 * Returns a required environment variable or throws if it is missing/empty.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Validates required configuration. Throws with a list of all problems found.
 * - JWT_SECRET and JWT_REFRESH_SECRET are required in every environment.
 * - Outside development/test they must be at least 32 characters, must not be a
 *   known insecure value, and must differ from each other.
 * - OTP_BYPASS_ENABLED=true (static test OTP) is refused outside development/test.
 * - MSG91 (login OTP SMS) is required outside development/test.
 */
export function validateEnv(): void {
  const errors: string[] = [];
  const nodeEnv = process.env.NODE_ENV;
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
      errors.push(`${name} is required.`);
      continue;
    }
    if (!isDevOrTest) {
      if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
        errors.push(`${name} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters outside development/test.`);
      }
      if (KNOWN_INSECURE_SECRETS.includes(value)) {
        errors.push(`${name} uses a known insecure value.`);
      }
    }
  }

  if (
    !isDevOrTest &&
    process.env.JWT_SECRET &&
    process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET
  ) {
    errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different.');
  }

  // Cashfree (D-020): optional (cash-only without it), but when configured on a production
  // server it must be complete, use production keys and have a public HTTPS webhook URL.
  const cashfreeVars = ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'];
  const cashfreeSet = cashfreeVars.filter((name) => process.env[name]?.trim());
  if (cashfreeSet.length > 0 && cashfreeSet.length < cashfreeVars.length) {
    errors.push('Set both CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET, or neither.');
  }
  const cashfreeEnv = process.env.CASHFREE_ENV?.trim().toLowerCase();
  if (cashfreeEnv && cashfreeEnv !== 'sandbox' && cashfreeEnv !== 'production') {
    errors.push('CASHFREE_ENV must be "sandbox" or "production".');
  }
  if (!isDevOrTest && cashfreeSet.length === cashfreeVars.length) {
    if (cashfreeEnv !== 'production') {
      errors.push('CASHFREE_ENV must be "production" outside development/test.');
    }
    if (!process.env.PUBLIC_API_BASE_URL?.trim().startsWith('https://')) {
      errors.push('PUBLIC_API_BASE_URL must be the public https:// address of this API (Cashfree webhooks).');
    }
  }

  // Login OTPs (P-003: MSG91): a production server cannot log anyone in without SMS.
  const msg91Set = ['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID'].filter((name) => process.env[name]?.trim());
  if (msg91Set.length === 1) {
    errors.push('Set both MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID, or neither.');
  } else if (!isDevOrTest && msg91Set.length === 0) {
    errors.push('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required outside development/test (login OTP SMS).');
  }

  // The static test OTP must never be switched on for a production-like server.
  if (!isDevOrTest && process.env.OTP_BYPASS_ENABLED === 'true') {
    errors.push('OTP_BYPASS_ENABLED must not be true outside development/test.');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }
}
