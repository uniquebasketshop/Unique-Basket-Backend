import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import jwt from 'jsonwebtoken';

describe('Admin & Customer Supported Pincodes & Serviceability Integration Tests', () => {
  const jwtSecret = process.env.JWT_SECRET || 'secret';
  let superAdminToken: string;
  let superAdminId: string;
  let storeManagerToken: string;
  let customerToken: string;
  let customerId: string;

  beforeAll(async () => {
    // 1. Fetch Super Admin
    const superAdmin = await prisma.adminUser.findFirst({
      where: { role: 'SUPER_ADMIN' },
    });
    if (!superAdmin) throw new Error('Super Admin not found in test db');
    superAdminId = superAdmin.id;
    superAdminToken = jwt.sign(
      { id: superAdmin.id, email: superAdmin.email, role: superAdmin.role },
      jwtSecret,
      { expiresIn: '1h' }
    );

    // 2. Fetch Store Manager
    const storeManager = await prisma.adminUser.findFirst({
      where: { role: 'STORE_MANAGER' },
    });
    if (!storeManager) throw new Error('Store Manager not found in test db');
    storeManagerToken = jwt.sign(
      { id: storeManager.id, email: storeManager.email, role: storeManager.role },
      jwtSecret,
      { expiresIn: '1h' }
    );

    // 3. Create or fetch test customer
    let customer = await prisma.user.findFirst({
      where: { phone: '+919988776655' },
    });
    if (!customer) {
      customer = await prisma.user.create({
        data: {
          phone: '+919988776655',
          name: 'Pincode Test Customer',
        },
      });
    }
    customerId = customer.id;
    customerToken = jwt.sign(
      { id: customer.id, phone: customer.phone, role: 'customer' },
      jwtSecret,
      { expiresIn: '1h' }
    );

    // 4. Ensure baseline initial pincodes 360001-360007 exist
    const count = await prisma.supportedPincode.count();
    if (count === 0) {
      await prisma.supportedPincode.createMany({
        data: [
          { pincode: '360001', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360002', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360003', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360004', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360005', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360006', city: 'Rajkot', state: 'Gujarat', isActive: true },
          { pincode: '360007', city: 'Rajkot', state: 'Gujarat', isActive: true },
        ],
      });
    }
  });

  afterAll(async () => {
    // Cleanup any temporary pincodes created for tests
    await prisma.supportedPincode.deleteMany({
      where: {
        pincode: { in: ['360099', '360088', '360077'] },
      },
    });
  });

  describe('Super Admin Pincode Management APIs', () => {
    it('1. Rejects unauthenticated request to /api/v1/admin/pincodes with 401', async () => {
      const res = await request(app).get('/api/v1/admin/pincodes');
      expect(res.status).toBe(401);
    });

    it('2. Rejects Store Manager attempting to access /api/v1/admin/pincodes with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/pincodes')
        .set('Authorization', `Bearer ${storeManagerToken}`);
      expect(res.status).toBe(403);
    });

    it('3. Allows Super Admin to list supported pincodes', async () => {
      const res = await request(app)
        .get('/api/v1/admin/pincodes')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(7);
      const pincode360001 = res.body.data.find((p: any) => p.pincode === '360001');
      expect(pincode360001).toBeDefined();
      expect(pincode360001.city).toBe('Rajkot');
      expect(pincode360001.state).toBe('Gujarat');
      expect(pincode360001.isActive).toBe(true);
    });

    it('4. Rejects pincode creation with invalid format (not 6 digits)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/pincodes')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          pincode: '12345', // 5 digits
          city: 'Rajkot',
          state: 'Gujarat',
        });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('INVALID_PINCODE_FORMAT');
    });

    it('5. Allows Super Admin to create a new supported pincode and logs audit trail', async () => {
      // Ensure clean state
      await prisma.supportedPincode.deleteMany({ where: { pincode: '360099' } });

      const res = await request(app)
        .post('/api/v1/admin/pincodes')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          pincode: '360099',
          city: 'Rajkot',
          state: 'Gujarat',
          isActive: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pincode).toBe('360099');
      expect(res.body.data.city).toBe('Rajkot');

      // Check audit log
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'SUPPORTED_PINCODE_CREATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeDefined();
      expect(audit?.details).toContain('360099');
    });

    it('6. Rejects duplicate pincode creation', async () => {
      const res = await request(app)
        .post('/api/v1/admin/pincodes')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          pincode: '360099',
          city: 'Rajkot',
          state: 'Gujarat',
        });
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('DUPLICATE_PINCODE');
    });

    it('7. Allows Super Admin to update pincode details', async () => {
      const pin = await prisma.supportedPincode.findUnique({ where: { pincode: '360099' } });
      if (!pin) throw new Error('360099 not found');

      const res = await request(app)
        .put(`/api/v1/admin/pincodes/${pin.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          city: 'Rajkot South',
          state: 'Gujarat',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.city).toBe('Rajkot South');
    });

    it('8. Allows Super Admin to toggle/deactivate and reactivate a pincode', async () => {
      const pin = await prisma.supportedPincode.findUnique({ where: { pincode: '360099' } });
      if (!pin) throw new Error('360099 not found');

      // Deactivate
      const res1 = await request(app)
        .patch(`/api/v1/admin/pincodes/${pin.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isActive: false });

      expect(res1.status).toBe(200);
      expect(res1.body.data.isActive).toBe(false);

      // Reactivate
      const res2 = await request(app)
        .patch(`/api/v1/admin/pincodes/${pin.id}/status`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ isActive: true });

      expect(res2.status).toBe(200);
      expect(res2.body.data.isActive).toBe(true);
    });
  });

  describe('Customer Serviceability APIs', () => {
    it('9. Public / Customer can fetch active supported pincodes from /api/v1/customer/pincodes', async () => {
      const res = await request(app).get('/api/v1/customer/pincodes');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const pincodes = res.body.data.map((p: any) => p.pincode);
      expect(pincodes).toContain('360001');
      expect(pincodes).toContain('360099');
    });

    it('10. Customer can check single pincode serviceability', async () => {
      const resActive = await request(app)
        .get('/api/v1/customer/serviceability/check?pincode=360001');
      expect(resActive.status).toBe(200);
      expect(resActive.body.data.isServiceable).toBe(true);

      const resInactive = await request(app)
        .get('/api/v1/customer/serviceability/check?pincode=999999');
      expect(resInactive.status).toBe(200);
      expect(resInactive.body.data.isServiceable).toBe(false);
    });
  });

  describe('Database-Authoritative Address Validation', () => {
    it('11. Customer can create an address with active supported pincode (360001)', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          title: 'Home',
          addressLine: 'Flat 101, Green Heights',
          pincode: '360001',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.pincode).toBe('360001');
      expect(res.body.data.address.city).toBe('Rajkot');
    });

    it('12. Customer address creation is rejected when pincode is not supported in DB', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          title: 'Office',
          addressLine: 'Sector 5, Unsupported Area',
          pincode: '360098', // Not in database
        });

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('PINCODE_NOT_SERVICEABLE');
    });

    it('13. Deactivating a pincode causes new address creation for that pincode to be rejected', async () => {
      const pin = await prisma.supportedPincode.findUnique({ where: { pincode: '360099' } });
      if (!pin) throw new Error('360099 not found');

      // Deactivate 360099
      await prisma.supportedPincode.update({
        where: { id: pin.id },
        data: { isActive: false },
      });

      // Attempt creating address with now-inactive 360099
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          title: 'Deactivated Test',
          addressLine: 'Road 2, Area 360099',
          pincode: '360099',
        });

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('PINCODE_NOT_SERVICEABLE');
    });

    it('14. Reactivating the pincode immediately allows new address creation without code changes', async () => {
      const pin = await prisma.supportedPincode.findUnique({ where: { pincode: '360099' } });
      if (!pin) throw new Error('360099 not found');

      // Reactivate 360099
      await prisma.supportedPincode.update({
        where: { id: pin.id },
        data: { isActive: true },
      });

      // Attempt creating address with now-active 360099
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          title: 'Reactivated Test',
          addressLine: 'Road 2, Area 360099',
          pincode: '360099',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.pincode).toBe('360099');
    });

    it('15. Updating address to unserviceable pincode is rejected', async () => {
      const addr = await prisma.userAddress.findFirst({
        where: { userId: customerId },
      });
      if (!addr) throw new Error('Address not found');

      const res = await request(app)
        .put(`/api/v1/customer/addresses/${addr.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          pincode: '888888',
        });

      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('PINCODE_NOT_SERVICEABLE');
    });
  });
});
