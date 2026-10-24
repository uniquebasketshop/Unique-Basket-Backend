/**
 * Test-only environment defaults (P0-02).
 * The application has no fallback secrets, so tests supply explicit, non-production values.
 * Values already set in the environment take precedence.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_only_jwt_access_secret_not_for_production';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test_only_jwt_refresh_secret_not_for_production';
// Static test OTP 1234 (dev/test only, D-004); tests that need real OTPs unset it.
process.env.OTP_BYPASS_ENABLED = process.env.OTP_BYPASS_ENABLED || 'true';
// Never use the developer's real Cashfree keys from backend/.env in tests: blank values win over
// dotenv (it does not override existing variables). Payment tests install the fake Cashfree.
process.env.CASHFREE_CLIENT_ID = '';
process.env.CASHFREE_CLIENT_SECRET = '';
process.env.CASHFREE_ENV = '';
process.env.PUBLIC_API_BASE_URL = '';
// Never send real SMS from tests: blank the developer's MSG91 keys (tests use a fake fetch).
process.env.MSG91_AUTH_KEY = '';
process.env.MSG91_OTP_TEMPLATE_ID = '';
