import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';

describe('Customer Marketing Banners API Integration Tests', () => {
  let customerToken: string;
  let customerId: string;
  const createdBannerIds: string[] = [];

  beforeAll(async () => {
    // Find or create a test customer
    let user = await prisma.user.findFirst();

    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: '+919999988888',
          name: 'Banner Test Customer',
        },
      });
    }

    customerId = user.id;
    customerToken = generateAccessToken({
      id: user.id,
      role: 'customer',
    });

    // Create known test banners
    const b1 = await prisma.banner.create({
      data: {
        title: 'Test Active Banner 1',
        imageUrl: 'https://images.unsplash.com/photo-1540420773420-3366772f4999',
        displayOrder: 1,
        isActive: true,
      },
    });
    createdBannerIds.push(b1.id);

    const b2 = await prisma.banner.create({
      data: {
        title: 'Test Inactive Banner',
        imageUrl: 'https://images.unsplash.com/photo-inactive',
        displayOrder: 0,
        isActive: false,
      },
    });
    createdBannerIds.push(b2.id);

    const b3 = await prisma.banner.create({
      data: {
        title: 'Test Active Banner 2',
        imageUrl: 'https://images.unsplash.com/photo-1610832958506-aa56368176cf',
        displayOrder: 2,
        isActive: true,
      },
    });
    createdBannerIds.push(b3.id);
  });

  afterAll(async () => {
    if (createdBannerIds.length > 0) {
      await prisma.banner.deleteMany({
        where: { id: { in: createdBannerIds } },
      });
    }
  });

  test('1. Rejects unauthenticated request with 401 UNAUTHORIZED_ACCESS', async () => {
    const res = await request(app).get('/api/v1/banners');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.errorCode).toBe('UNAUTHORIZED_ACCESS');
  });

  test('2. Authenticated customer can fetch active banners', async () => {
    const res = await request(app)
      .get('/api/v1/banners')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  test('3. Excludes inactive banners and respects displayOrder', async () => {
    const res = await request(app)
      .get('/api/v1/banners')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(200);
    const banners: Array<{ id: string; title: string; isActive: boolean; displayOrder: number }> =
      res.body.data;

    // Check inactive banner is not present
    const inactiveBanner = banners.find((b) => b.title === 'Test Inactive Banner');
    expect(inactiveBanner).toBeUndefined();

    // Check all returned banners are active
    for (const banner of banners) {
      expect(banner.isActive).toBe(true);
    }

    // Check displayOrder ordering
    for (let i = 0; i < banners.length - 1; i++) {
      expect(banners[i].displayOrder).toBeLessThanOrEqual(banners[i + 1].displayOrder);
    }
  });

  test('4. Correct imageUrl and fields are returned in customer contract', async () => {
    const res = await request(app)
      .get('/api/v1/banners')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(200);
    const banner1 = res.body.data.find((b: any) => b.title === 'Test Active Banner 1');
    expect(banner1).toBeDefined();
    expect(banner1.imageUrl).toBe('https://images.unsplash.com/photo-1540420773420-3366772f4999');
    expect(banner1.displayOrder).toBe(1);
    expect(banner1.isActive).toBe(true);
  });
});
