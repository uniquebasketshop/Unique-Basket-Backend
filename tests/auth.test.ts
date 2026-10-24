import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';

describe('Authentication Flow Integration Tests', () => {
  const testPhone = '+919999999999';
  const testOtp = '1234'; // Temporary static OTP for development/testing

  beforeAll(async () => {
    // Ensure any pre-existing test user is removed to assert new user flows
    await prisma.user.deleteMany({
      where: { phone: testPhone },
    });
  });

  afterAll(async () => {
    // Cleanup test user and close DB pool connections
    await prisma.user.deleteMany({
      where: { phone: testPhone },
    });
    await prisma.$disconnect();
  });

  describe('Customer OTP Flow', () => {
    it('should successfully send an OTP and include temporary OTP 1234 in test environment', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: testPhone });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('otp', '1234');
    });

    it('should NOT expose OTP in production environment', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(app)
          .post('/api/v1/auth/send-otp')
          .send({ phone: '+919999999998' });

        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('success', true);
        expect(res.body).not.toHaveProperty('otp');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should fail to send an OTP to an invalid mobile format', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: 'invalid-phone-string' });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_PHONE_FORMAT');
    });

    it('should successfully verify a correct OTP (1234) and register a new user', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ phone: testPhone, otp: testOtp });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data).toHaveProperty('isNewUser', true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data).toHaveProperty('refreshToken');
      expect(res.body.data.user).toHaveProperty('phone', testPhone);
    });

    it('should fail when verifying with an incorrect OTP code (0000, 9999, 1111)', async () => {
      // Re-send OTP to have an active record
      await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: testPhone });

      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ phone: testPhone, otp: '9999' });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'OTP_VERIFICATION_FAILED');
    });
  });

  describe('Admin Login Flow', () => {
    it('should successfully authenticate super admin credentials', async () => {
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'superadmin@uniquebasket.com',
          password: 'SuperSecretPassword123',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.admin).toHaveProperty('role', 'SUPER_ADMIN');
      expect(res.body.data).toHaveProperty('token');
    });

    it('should successfully authenticate store manager credentials and return assigned storeId', async () => {
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'manager1@uniquebasket.com',
          password: 'ManagerPassword123',
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body.data.admin).toHaveProperty('role', 'STORE_MANAGER');
      expect(res.body.data.admin).toHaveProperty('storeId');
      expect(res.body.data.admin.storeId).not.toBeNull();
    });

    it('should reject login for incorrect administrative password', async () => {
      const res = await request(app)
        .post('/api/v1/admin/login')
        .send({
          email: 'superadmin@uniquebasket.com',
          password: 'WrongPassword',
        });

      expect(res.statusCode).toEqual(401);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('errorCode', 'INVALID_CREDENTIALS');
    });

    it('gives the same answer for an unknown email and a wrong password (no account enumeration)', async () => {
      const unknown = await request(app)
        .post('/api/v1/admin/login')
        .send({ email: 'nobody-here@uniquebasket.com', password: 'WrongPassword' });
      const wrongPassword = await request(app)
        .post('/api/v1/admin/login')
        .send({ email: 'superadmin@uniquebasket.com', password: 'WrongPassword' });

      expect(unknown.statusCode).toEqual(401);
      expect(unknown.body).toEqual(wrongPassword.body);
      expect(unknown.body).toEqual({ success: false, message: 'Invalid email or password.', errorCode: 'INVALID_CREDENTIALS' });
    });

    it('does not reveal a deactivated account unless the password is correct', async () => {
      const email = `deactivated-admin-${Date.now()}@uniquebasket.com`;
      await prisma.adminUser.create({
        data: { email, name: 'Deactivated Admin', role: 'SUPER_ADMIN', isActive: false, passwordHash: await bcrypt.hash('CorrectPassword1', 10) },
      });
      try {
        const wrong = await request(app).post('/api/v1/admin/login').send({ email, password: 'WrongPassword' });
        expect(wrong.statusCode).toEqual(401);
        expect(wrong.body.errorCode).toEqual('INVALID_CREDENTIALS');
        expect(wrong.body.message).toEqual('Invalid email or password.');

        const right = await request(app).post('/api/v1/admin/login').send({ email, password: 'CorrectPassword1' });
        expect(right.statusCode).toEqual(401);
        expect(right.body.errorCode).toEqual('ACCOUNT_DEACTIVATED');
        expect(right.body.data).toBeUndefined();
      } finally {
        await prisma.adminUser.deleteMany({ where: { email } });
      }
    });
  });
});
