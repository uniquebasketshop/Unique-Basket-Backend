import { validateEnv, requireEnv } from '../src/config/validateEnv';
import { generateAccessToken, verifyAccessToken, generateRefreshToken, verifyRefreshToken } from '../src/utils/jwt';

describe('Environment validation and JWT secrets (P0-02)', () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    OTP_BYPASS_ENABLED: process.env.OTP_BYPASS_ENABLED,
    CASHFREE_CLIENT_ID: process.env.CASHFREE_CLIENT_ID,
    CASHFREE_CLIENT_SECRET: process.env.CASHFREE_CLIENT_SECRET,
    CASHFREE_ENV: process.env.CASHFREE_ENV,
    PUBLIC_API_BASE_URL: process.env.PUBLIC_API_BASE_URL,
    MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY,
    MSG91_OTP_TEMPLATE_ID: process.env.MSG91_OTP_TEMPLATE_ID,
  };
  // Production needs login OTP SMS (P-003: MSG91)
  const withMsg91 = () => {
    process.env.MSG91_AUTH_KEY = 'msg91-auth-key';
    process.env.MSG91_OTP_TEMPLATE_ID = 'template-id';
  };

  const strongAccess = 'a'.repeat(40);
  const strongRefresh = 'b'.repeat(40);

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('validateEnv', () => {
    it('fails when JWT secrets are missing, in every environment', () => {
      for (const env of [undefined, 'production', 'development', 'test']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        delete process.env.JWT_SECRET;
        delete process.env.JWT_REFRESH_SECRET;

        expect(() => validateEnv()).toThrow(/JWT_SECRET is required/);
        expect(() => validateEnv()).toThrow(/JWT_REFRESH_SECRET is required/);
      }
    });

    it('rejects short secrets outside development/test (including unset NODE_ENV)', () => {
      for (const env of [undefined, 'production', 'staging']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        process.env.JWT_SECRET = 'short';
        process.env.JWT_REFRESH_SECRET = strongRefresh;

        expect(() => validateEnv()).toThrow(/JWT_SECRET must be at least 32 characters/);
      }
    });

    it('rejects the previous hard-coded values outside development/test', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'fallback_access_secret';
      process.env.JWT_REFRESH_SECRET = 'fallback_refresh_secret';

      expect(() => validateEnv()).toThrow(/known insecure value/);
    });

    it('rejects identical access and refresh secrets outside development/test', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = strongAccess;
      process.env.JWT_REFRESH_SECRET = strongAccess;

      expect(() => validateEnv()).toThrow(/must be different/);
    });

    it('refuses the static test OTP switch outside development/test', () => {
      for (const env of [undefined, 'production', 'staging']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        process.env.JWT_SECRET = strongAccess;
        process.env.JWT_REFRESH_SECRET = strongRefresh;
        process.env.OTP_BYPASS_ENABLED = 'true';

        expect(() => validateEnv()).toThrow(/OTP_BYPASS_ENABLED must not be true/);
      }
    });

    it('allows the static test OTP switch in development/test', () => {
      for (const env of ['development', 'test']) {
        process.env.NODE_ENV = env;
        process.env.OTP_BYPASS_ENABLED = 'true';
        expect(() => validateEnv()).not.toThrow();
      }
    });

    describe('Cashfree settings', () => {
      const production = () => {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = strongAccess;
        process.env.JWT_REFRESH_SECRET = strongRefresh;
        delete process.env.OTP_BYPASS_ENABLED;
        withMsg91();
      };

      it('is optional: no Cashfree settings means cash only', () => {
        production();
        delete process.env.CASHFREE_CLIENT_ID;
        delete process.env.CASHFREE_CLIENT_SECRET;
        delete process.env.CASHFREE_ENV;
        expect(() => validateEnv()).not.toThrow();
      });

      it('needs both the App ID and the Secret Key', () => {
        production();
        process.env.CASHFREE_CLIENT_ID = 'app-id';
        delete process.env.CASHFREE_CLIENT_SECRET;
        expect(() => validateEnv()).toThrow(/both CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET/);
      });

      it('in production needs production mode and a public https URL for webhooks', () => {
        production();
        process.env.CASHFREE_CLIENT_ID = 'app-id';
        process.env.CASHFREE_CLIENT_SECRET = 'secret';
        process.env.CASHFREE_ENV = 'sandbox';
        process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';
        expect(() => validateEnv()).toThrow(/CASHFREE_ENV must be "production"/);
        expect(() => validateEnv()).toThrow(/PUBLIC_API_BASE_URL must be the public https/);

        process.env.CASHFREE_ENV = 'production';
        process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';
        expect(() => validateEnv()).not.toThrow();
      });

      it('rejects an unknown CASHFREE_ENV anywhere', () => {
        process.env.NODE_ENV = 'development';
        process.env.CASHFREE_ENV = 'live';
        expect(() => validateEnv()).toThrow(/CASHFREE_ENV must be "sandbox" or "production"/);
      });
    });

    it('accepts strong, distinct secrets in production', () => {
      delete process.env.OTP_BYPASS_ENABLED;
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = strongAccess;
      process.env.JWT_REFRESH_SECRET = strongRefresh;
      withMsg91();

      expect(() => validateEnv()).not.toThrow();
    });

    describe('MSG91 login OTP SMS (P-003)', () => {
      const production = () => {
        delete process.env.OTP_BYPASS_ENABLED;
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = strongAccess;
        process.env.JWT_REFRESH_SECRET = strongRefresh;
      };

      it('is required in production (nobody could log in without SMS)', () => {
        production();
        delete process.env.MSG91_AUTH_KEY;
        delete process.env.MSG91_OTP_TEMPLATE_ID;
        expect(() => validateEnv()).toThrow(/MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required/);
        withMsg91();
        expect(() => validateEnv()).not.toThrow();
      });

      it('needs both the auth key and the template ID, everywhere', () => {
        for (const env of ['production', 'development']) {
          process.env.NODE_ENV = env;
          process.env.JWT_SECRET = strongAccess;
          process.env.JWT_REFRESH_SECRET = strongRefresh;
          process.env.MSG91_AUTH_KEY = 'msg91-auth-key';
          delete process.env.MSG91_OTP_TEMPLATE_ID;
          expect(() => validateEnv()).toThrow(/Set both MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID/);
        }
      });

      it('is optional in development (static test OTP or console)', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.MSG91_AUTH_KEY;
        delete process.env.MSG91_OTP_TEMPLATE_ID;
        expect(() => validateEnv()).not.toThrow();
      });
    });

    it('accepts any non-empty secrets in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'dev';
      process.env.JWT_REFRESH_SECRET = 'dev-refresh';

      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('requireEnv', () => {
    it('throws for missing or blank values', () => {
      delete process.env.JWT_SECRET;
      expect(() => requireEnv('JWT_SECRET')).toThrow(/Missing required environment variable: JWT_SECRET/);
      process.env.JWT_SECRET = '   ';
      expect(() => requireEnv('JWT_SECRET')).toThrow(/JWT_SECRET/);
    });
  });

  describe('JWT utilities have no fallback secrets', () => {
    it('cannot sign or verify tokens when secrets are missing', () => {
      delete process.env.JWT_SECRET;
      delete process.env.JWT_REFRESH_SECRET;

      expect(() => generateAccessToken({ id: 'u1', role: 'customer' })).toThrow(/JWT_SECRET/);
      expect(() => generateRefreshToken({ id: 'u1', role: 'customer' })).toThrow(/JWT_REFRESH_SECRET/);
      expect(() => verifyAccessToken('any.token.value')).toThrow(/JWT_SECRET/);
      expect(() => verifyRefreshToken('any.token.value')).toThrow(/JWT_REFRESH_SECRET/);
    });

    it('rejects tokens signed with the old fallback secret', () => {
      process.env.JWT_SECRET = strongAccess;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jwt = require('jsonwebtoken');
      const forged = jwt.sign({ id: 'admin', role: 'SUPER_ADMIN' }, 'fallback_access_secret');

      expect(() => verifyAccessToken(forged)).toThrow();
    });

    it('round-trips tokens with the configured secret', () => {
      process.env.JWT_SECRET = strongAccess;
      const token = generateAccessToken({ id: 'u1', role: 'customer', phone: '+919999999999' });
      expect(verifyAccessToken(token)).toMatchObject({ id: 'u1', role: 'customer' });
    });
  });
});
