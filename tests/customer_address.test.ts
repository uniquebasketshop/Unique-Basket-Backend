import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Customer Address Management API Tests (Screen 29)', () => {
  const customer1Phone = '+919999000081';
  const customer2Phone = '+919999000082';
  let user1Id: string;
  let user2Id: string;
  let token1: string;
  let token2: string;

  beforeAll(async () => {
    // Find and clean addresses for these users first if any
    const existingUsers = await prisma.user.findMany({
      where: { phone: { in: [customer1Phone, customer2Phone] } },
      select: { id: true },
    });
    const userIds = existingUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await prisma.userAddress.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }

    // Create Customer 1
    const user1 = await prisma.user.create({
      data: {
        phone: customer1Phone,
        name: 'Maulik Patel',
      },
    });
    user1Id = user1.id;
    token1 = generateAccessToken({
      id: user1.id,
      role: 'customer',
      phone: user1.phone,
    });

    // Create Customer 2
    const user2 = await prisma.user.create({
      data: {
        phone: customer2Phone,
        name: 'Other Customer',
      },
    });
    user2Id = user2.id;
    token2 = generateAccessToken({
      id: user2.id,
      role: 'customer',
      phone: user2.phone,
    });
  });

  afterAll(async () => {
    await prisma.userAddress.deleteMany({
      where: { userId: { in: [user1Id, user2Id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [user1Id, user2Id] } },
    });
    await prisma.$disconnect();
  });

  describe('Address Management Flow', () => {
    let address1Id: string;
    let address2Id: string;

    it('10. should reject unauthenticated request', async () => {
      const res = await request(app).get('/api/v1/customer/addresses');
      expect(res.statusCode).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('8. should reject invalid Rajkot pincode', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          title: 'Out of area',
          addressLine: '123 Fake Street',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400001',
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('PINCODE_NOT_SERVICEABLE');
    });

    it('9. should accept valid Rajkot pincode and create first default address', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          title: 'Home',
          addressLine: '123, Example Road, Green Heights',
          city: 'Rajkot',
          state: 'Gujarat',
          pincode: '360001',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.isDefault).toBe(true);
      expect(res.body.data.address.pincode).toBe('360001');
      address1Id = res.body.data.address.id;
    });

    it('should create second address without default', async () => {
      const res = await request(app)
        .post('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${token1}`)
        .send({
          title: 'Office / Work',
          addressLine: 'Unit 402, 4th Floor, Tech Park',
          city: 'Rajkot',
          state: 'Gujarat',
          pincode: '360004',
          isDefault: false,
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.isDefault).toBe(false);
      address2Id = res.body.data.address.id;
    });

    it('1. should allow authenticated customer to update own address', async () => {
      const res = await request(app)
        .put(`/api/v1/customer/addresses/${address1Id}`)
        .set('Authorization', `Bearer ${token1}`)
        .send({
          title: 'Home (Updated)',
          addressLine: '123, Example Road, Green Heights, Opp. Central Park',
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.title).toBe('Home (Updated)');
      expect(res.body.data.address.addressLine).toContain('Opp. Central Park');
    });

    it('2. should prevent customer from updating another customer\'s address', async () => {
      const res = await request(app)
        .put(`/api/v1/customer/addresses/${address1Id}`)
        .set('Authorization', `Bearer ${token2}`)
        .send({
          title: 'Hacked Address',
        });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('ADDRESS_NOT_FOUND');
    });

    it('5. setting one address as default unsets previous default', async () => {
      const res = await request(app)
        .patch(`/api/v1/customer/addresses/${address2Id}/default`)
        .set('Authorization', `Bearer ${token1}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address.isDefault).toBe(true);

      // Verify address 1 is no longer default
      const addr1 = await prisma.userAddress.findUnique({ where: { id: address1Id } });
      expect(addr1?.isDefault).toBe(false);
    });

    it('4. should prevent customer from deleting another customer\'s address', async () => {
      const res = await request(app)
        .delete(`/api/v1/customer/addresses/${address2Id}`)
        .set('Authorization', `Bearer ${token2}`);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('ADDRESS_NOT_FOUND');
    });

    it('6. deleting default address selects a deterministic remaining default', async () => {
      // address 2 is current default; delete it
      const res = await request(app)
        .delete(`/api/v1/customer/addresses/${address2Id}`)
        .set('Authorization', `Bearer ${token1}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify address 1 became default automatically
      const addr1 = await prisma.userAddress.findUnique({ where: { id: address1Id } });
      expect(addr1?.isDefault).toBe(true);
    });

    it('3. & 7. deleting only remaining address leaves zero addresses', async () => {
      const res = await request(app)
        .delete(`/api/v1/customer/addresses/${address1Id}`)
        .set('Authorization', `Bearer ${token1}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app)
        .get('/api/v1/customer/addresses')
        .set('Authorization', `Bearer ${token1}`);

      expect(listRes.statusCode).toBe(200);
      expect(listRes.body.data.addresses.length).toBe(0);
    });
  });
});
