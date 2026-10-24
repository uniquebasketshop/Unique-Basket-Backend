import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Customer Favourites API Tests', () => {
  const customer1Phone = '+919999000091';
  const customer2Phone = '+919999000092';
  let user1Id: string;
  let user2Id: string;
  let token1: string;
  let token2: string;
  let testProductId1: string;
  let testProductId2: string;
  let testCategoryId: string;

  beforeAll(async () => {
    // Clean up test data if existing
    const existingUsers = await prisma.user.findMany({
      where: { phone: { in: [customer1Phone, customer2Phone] } },
      select: { id: true },
    });
    const userIds = existingUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await prisma.favorite.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    // Create Category & Products for tests
    const category = await prisma.category.upsert({
      where: { name: 'Test Category For Favorites' },
      update: {},
      create: {
        name: 'Test Category For Favorites',
        description: 'Testing favorites API',
      },
    });
    testCategoryId = category.id;

    const prod1 = await prisma.product.create({
      data: {
        name: 'Organic Hass Avocados Test',
        categoryId: testCategoryId,
        price: 180.0,
        unit: 'PACK',
        isActive: true,
      },
    });
    testProductId1 = prod1.id;

    const prod2 = await prisma.product.create({
      data: {
        name: 'Fresh Kale Test',
        categoryId: testCategoryId,
        price: 60.0,
        unit: 'KG',
        isActive: true,
      },
    });
    testProductId2 = prod2.id;

    // Create Customer 1
    const user1 = await prisma.user.create({
      data: {
        phone: customer1Phone,
        name: 'Maulik Patel Fav Test',
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
        name: 'Second Customer Fav Test',
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
    await prisma.favorite.deleteMany({ where: { userId: { in: [user1Id, user2Id] } } });
    await prisma.product.deleteMany({ where: { id: { in: [testProductId1, testProductId2] } } });
    await prisma.category.deleteMany({ where: { id: testCategoryId } });
    await prisma.user.deleteMany({ where: { id: { in: [user1Id, user2Id] } } });
    await prisma.$disconnect();
  });

  test('1. Rejects unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/v1/customer/favorites');
    expect(res.status).toBe(401);
  });

  test('2. Allows authenticated customer to add product to favorites', async () => {
    const res = await request(app)
      .post(`/api/v1/customer/favorites/${testProductId1}`)
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productId).toBe(testProductId1);

    // Add second product
    const res2 = await request(app)
      .post('/api/v1/customer/favorites')
      .set('Authorization', `Bearer ${token1}`)
      .send({ productId: testProductId2 });

    expect(res2.status).toBe(201);
    expect(res2.body.data.productId).toBe(testProductId2);
  });

  test('3. Fetches customer favorites correctly with productIds and details', async () => {
    const res = await request(app)
      .get('/api/v1/customer/favorites')
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productIds).toContain(testProductId1);
    expect(res.body.data.productIds).toContain(testProductId2);
    expect(res.body.data.favorites.length).toBe(2);
  });

  test('4. Enforces customer account isolation (Customer 2 has empty favorites)', async () => {
    const res = await request(app)
      .get('/api/v1/customer/favorites')
      .set('Authorization', `Bearer ${token2}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.productIds).toHaveLength(0);
  });

  test('5. Allows customer to remove product from favorites', async () => {
    const res = await request(app)
      .delete(`/api/v1/customer/favorites/${testProductId1}`)
      .set('Authorization', `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify product 1 is gone but product 2 remains
    const getRes = await request(app)
      .get('/api/v1/customer/favorites')
      .set('Authorization', `Bearer ${token1}`);

    expect(getRes.body.data.productIds).not.toContain(testProductId1);
    expect(getRes.body.data.productIds).toContain(testProductId2);
  });
});
