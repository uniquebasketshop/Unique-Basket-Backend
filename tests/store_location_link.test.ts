import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { isMapsShortLink, parseMapsCoordinates } from '../src/utils/mapsLocation';
import { isAllowedGoogleHost, resolveStoreLocation } from '../src/services/storeLocationService';

// The admin sets a store's location by pasting one Google Maps link (no separate lat/lng fields).
const FULL_LINK =
  'https://www.google.com/maps/place/Unique+Basket/@22.2711962,70.7647864,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d22.2711962!4d70.7673613!16s';

type Hop = { status: number; location?: string; body?: string };

/** Fake fetch answering each URL from [hops]; records the URLs asked for. */
function fakeFetch(hops: Record<string, Hop>) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const hop = hops[url];
    if (!hop) throw new Error(`unexpected fetch ${url}`);
    return new Response(hop.body ?? '', { status: hop.status, headers: hop.location ? { location: hop.location } : {} });
  }) as typeof fetch;
  return { impl, asked };
}

describe('Store location from a Google Maps link', () => {
  describe('parsing', () => {
    it('reads the exact pin from a full link (pin wins over the map centre)', () => {
      expect(parseMapsCoordinates(FULL_LINK)).toEqual({ latitude: 22.2711962, longitude: 70.7673613 });
    });

    it('reads "lat, lng", ?q= and @lat,lng forms; rejects out-of-range or text', () => {
      expect(parseMapsCoordinates(' 22.2916, 70.7932 ')).toEqual({ latitude: 22.2916, longitude: 70.7932 });
      expect(parseMapsCoordinates('https://maps.google.com/?q=22.30,70.80')).toEqual({ latitude: 22.3, longitude: 70.8 });
      expect(parseMapsCoordinates('https://www.google.com/maps/@22.29,70.79,15z')).toEqual({ latitude: 22.29, longitude: 70.79 });
      expect(parseMapsCoordinates('95.0, 70.0')).toBeNull();
      expect(parseMapsCoordinates('Rajkot store')).toBeNull();
    });

    it('recognises share links and only allows Google hosts', () => {
      expect(isMapsShortLink('https://maps.app.goo.gl/DyHzN2MAKeV8YxsT6')).toBe(true);
      expect(isMapsShortLink('maps.app.goo.gl/abc')).toBe(true);
      expect(isMapsShortLink('https://example.com/maps')).toBe(false);
      expect(isAllowedGoogleHost('www.google.com')).toBe(true);
      expect(isAllowedGoogleHost('www.google.co.in')).toBe(true);
      expect(isAllowedGoogleHost('google.com.evil.example')).toBe(false);
      expect(isAllowedGoogleHost('127.0.0.1')).toBe(false);
    });
  });

  describe('resolving share links', () => {
    it('follows a maps.app.goo.gl redirect to the full link and reads the pin', async () => {
      const { impl, asked } = fakeFetch({ 'https://maps.app.goo.gl/abc': { status: 302, location: FULL_LINK } });
      await expect(resolveStoreLocation('https://maps.app.goo.gl/abc', impl)).resolves.toEqual({
        latitude: 22.2711962,
        longitude: 70.7673613,
      });
      expect(asked).toEqual(['https://maps.app.goo.gl/abc']); // the pin was in the redirect: Google itself not fetched
    });

    it('reads the pin from the place page when the final link has no coordinates', async () => {
      const place = 'https://www.google.com/maps/place/Unique+Basket/data=!4m2!3m1!1s0x0:0x1';
      const { impl } = fakeFetch({
        'https://maps.app.goo.gl/xyz': { status: 302, location: place },
        [place]: { status: 200, body: '<meta content="https://maps.google.com/maps/api/staticmap?center=22.2711962%2C70.7673613&zoom=17">' },
      });
      await expect(resolveStoreLocation('maps.app.goo.gl/xyz', impl)).resolves.toEqual({ latitude: 22.2711962, longitude: 70.7673613 });
    });

    it('never follows a redirect away from Google', async () => {
      const { impl, asked } = fakeFetch({ 'https://maps.app.goo.gl/bad': { status: 302, location: 'http://169.254.169.254/latest' } });
      await expect(resolveStoreLocation('https://maps.app.goo.gl/bad', impl)).rejects.toMatchObject({ errorCode: 'LOCATION_NOT_FOUND' });
      expect(asked).toEqual(['https://maps.app.goo.gl/bad']);
    });

    it('does not fetch anything for other links or text', async () => {
      const { impl, asked } = fakeFetch({});
      await expect(resolveStoreLocation('https://example.com/store', impl)).rejects.toMatchObject({ status: 422, errorCode: 'LOCATION_NOT_FOUND' });
      expect(asked).toEqual([]);
    });

    it('stops after 5 redirects', async () => {
      const hops: Record<string, Hop> = {};
      for (let i = 0; i < 10; i++) hops[`https://maps.app.goo.gl/l${i}`] = { status: 302, location: `https://maps.app.goo.gl/l${i + 1}` };
      const { impl, asked } = fakeFetch(hops);
      await expect(resolveStoreLocation('https://maps.app.goo.gl/l0', impl)).rejects.toMatchObject({ errorCode: 'LOCATION_NOT_FOUND' });
      expect(asked.length).toBe(6);
    });

    it('reports a network failure separately', async () => {
      const impl = (async () => {
        throw new Error('offline');
      }) as typeof fetch;
      await expect(resolveStoreLocation('https://maps.app.goo.gl/abc', impl)).rejects.toMatchObject({ status: 502, errorCode: 'LOCATION_LOOKUP_FAILED' });
    });
  });

  describe('POST /api/v1/admin/stores/resolve-location', () => {
    let superAdminToken: string;
    let managerToken: string;

    beforeAll(async () => {
      const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
      const manager = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager1@uniquebasket.com' }, include: { managers: true } });
      superAdminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
      managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email, storeId: manager.managers[0]?.storeId });
    });

    const post = (token: string | null, body: unknown) => {
      const req = request(app).post('/api/v1/admin/stores/resolve-location');
      return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body as object);
    };

    it('returns coordinates for a full link (Super Admin only)', async () => {
      const res = await post(superAdminToken, { link: FULL_LINK });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, data: { latitude: 22.2711962, longitude: 70.7673613 } });

      expect((await post(null, { link: FULL_LINK })).statusCode).toBe(401);
      expect((await post(managerToken, { link: FULL_LINK })).statusCode).toBe(403);
    });

    it('follows a share link', async () => {
      const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 302, headers: { location: FULL_LINK } }));
      const res = await post(superAdminToken, { link: 'https://maps.app.goo.gl/DyHzN2MAKeV8YxsT6' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual({ latitude: 22.2711962, longitude: 70.7673613 });
      expect(String(spy.mock.calls[0][0])).toBe('https://maps.app.goo.gl/DyHzN2MAKeV8YxsT6');
    });

    it('rejects a missing, too long or unreadable link', async () => {
      expect((await post(superAdminToken, {})).statusCode).toBe(400);
      expect((await post(superAdminToken, { link: `https://maps.app.goo.gl/${'a'.repeat(2100)}` })).statusCode).toBe(400);
      const res = await post(superAdminToken, { link: 'somewhere in Rajkot' });
      expect(res.statusCode).toBe(422);
      expect(res.body.errorCode).toBe('LOCATION_NOT_FOUND');
    });
  });
});
