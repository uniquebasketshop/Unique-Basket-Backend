import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/db';
import { generateAccessToken } from '../src/utils/jwt';
import { computeAvailability, DEFAULT_TIMINGS, formatTime, istParts, StoreTimings } from '../src/services/storeScheduleService';

/** Instant for an IST wall-clock time (IST = UTC+5:30). */
const ist = (date: string, time: string) => new Date(Date.parse(`${date}T${time}:00+05:30`));

// 2026-10-05 is a Monday.
const MON = '2026-10-05';

describe('Store schedule rules (D-015)', () => {
  const timings: StoreTimings = { ...DEFAULT_TIMINGS };

  it('serves orders before the cut-off today', () => {
    const a = computeAvailability(timings, [], ist(MON, '12:30'));
    expect(a).toMatchObject({ openToday: true, fulfillmentDate: MON, fulfillmentDay: 'TODAY', label: 'Today', message: null });
  });

  it('serves early-morning orders today after opening', () => {
    const a = computeAvailability(timings, [], ist(MON, '07:00'));
    expect(a.fulfillmentDay).toBe('TODAY');
    expect(a.label).toBe('Today after 9:00 AM');
    expect(a.message).toBe('Store opens at 9:00 AM. Orders placed now will be delivered today after 9:00 AM.');
  });

  it('rolls orders at or after 7 PM to tomorrow', () => {
    for (const time of ['19:00', '23:59']) {
      const a = computeAvailability(timings, [], ist(MON, time));
      expect(a.fulfillmentDate).toBe('2026-10-06');
      expect(a.fulfillmentDay).toBe('TOMORROW');
      expect(a.label).toBe('Tomorrow after 9:00 AM');
      expect(a.message).toBe('Orders placed after 7:00 PM will be delivered tomorrow after 9:00 AM.');
    }
    expect(computeAvailability(timings, [], ist(MON, '18:59')).fulfillmentDay).toBe('TODAY');
  });

  it('shows the closed-today message on a holiday and serves the next open day', () => {
    const a = computeAvailability(timings, [{ date: MON, note: 'Diwali' }], ist(MON, '10:00'));
    expect(a.openToday).toBe(false);
    expect(a.closedReason).toBe('Diwali');
    expect(a.fulfillmentDay).toBe('TOMORROW');
    expect(a.message).toBe('Store is closed today (Diwali). Orders placed now will be delivered tomorrow after 9:00 AM.');
  });

  it('skips weekly closed days and consecutive holidays', () => {
    // Saturday after cut-off, Sunday weekly off, Monday holiday → Tuesday.
    const a = computeAvailability({ ...timings, weeklyClosedDays: [0] }, [{ date: MON, note: null }], ist('2026-10-03', '20:00'));
    expect(a.fulfillmentDate).toBe('2026-10-06');
    expect(a.fulfillmentDay).toBe('LATER');
    expect(a.label).toBe('Tue, 6 Oct after 9:00 AM');

    const sunday = computeAvailability({ ...timings, weeklyClosedDays: [0] }, [], ist('2026-10-04', '10:00'));
    expect(sunday).toMatchObject({ openToday: false, closedReason: 'Weekly off', fulfillmentDay: 'TOMORROW' });
    expect(sunday.message).toBe('Store is closed today. Orders placed now will be delivered tomorrow after 9:00 AM.');
  });

  it('gives pickup until the pickup closing time, and tomorrow from opening after the cut-off', () => {
    expect(computeAvailability(timings, [], ist(MON, '15:00'), 'PICKUP').label).toBe('Today, until 9:00 PM');
    const late = computeAvailability(timings, [], ist(MON, '19:30'), 'PICKUP');
    expect(late.label).toBe('Tomorrow from 9:00 AM');
    expect(late.message).toBe('Orders placed after 7:00 PM will be ready for pickup tomorrow from 9:00 AM.');
  });

  it('uses India time regardless of the server clock', () => {
    // 2026-10-05 14:00 UTC = 19:30 IST → tomorrow.
    expect(istParts(new Date('2026-10-05T14:00:00Z'))).toEqual({ date: MON, time: '19:30' });
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('21:00')).toBe('9:00 PM');
  });
});

describe('Store timings API (D-015)', () => {
  const phone = '+919888800015';
  let adminToken: string;
  let managerToken: string;
  let customerToken: string;
  let storeId: string;
  let original: { storeOpeningTime: string; orderCutoffTime: string; pickupClosingTime: string; weeklyClosedDays: number[] } | null;
  const createdHolidays: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'superadmin@uniquebasket.com' } });
    const manager = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'manager1@uniquebasket.com' } });
    const store = await prisma.store.findUniqueOrThrow({ where: { storeId: 'STORE-001' } });
    storeId = store.id;
    adminToken = generateAccessToken({ id: admin.id, role: 'SUPER_ADMIN', email: admin.email });
    managerToken = generateAccessToken({ id: manager.id, role: 'STORE_MANAGER', email: manager.email });
    const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone, name: 'Schedule Customer' } });
    customerToken = generateAccessToken({ id: user.id, role: 'customer', phone: user.phone });
    const settings = await prisma.deliverySettings.findFirst();
    original = settings && {
      storeOpeningTime: settings.storeOpeningTime,
      orderCutoffTime: settings.orderCutoffTime,
      pickupClosingTime: settings.pickupClosingTime,
      weeklyClosedDays: settings.weeklyClosedDays,
    };
  });

  afterAll(async () => {
    await prisma.storeHoliday.deleteMany({ where: { id: { in: createdHolidays } } });
    const settings = await prisma.deliverySettings.findFirst();
    if (settings && original) await prisma.deliverySettings.update({ where: { id: settings.id }, data: original });
    await prisma.store.update({ where: { id: storeId }, data: { useCustomTimings: false } });
    await prisma.auditLog.deleteMany({ where: { action: { in: ['STORE_TIMINGS_UPDATED', 'STORE_HOLIDAY_ADDED', 'STORE_HOLIDAY_REMOVED'] } } });
    await prisma.user.deleteMany({ where: { phone } });
    await prisma.$disconnect();
  });

  const admin = (method: 'get' | 'put' | 'post' | 'delete', url: string, token = adminToken) =>
    request(app)[method](`/api/v1/admin${url}`).set('Authorization', `Bearer ${token}`);

  it('returns the global timings (9:00 / 19:00 / 21:00 by default), stores and holidays', async () => {
    const res = await admin('get', '/store-timings');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.global).toEqual({ openingTime: '09:00', orderCutoffTime: '19:00', pickupClosingTime: '21:00', weeklyClosedDays: [] });
    expect(res.body.data.stores.find((s: { id: string }) => s.id === storeId)).toMatchObject({ useCustomTimings: false });
    expect(Array.isArray(res.body.data.holidays)).toBe(true);
  });

  it('is SUPER_ADMIN only', async () => {
    expect((await admin('get', '/store-timings', managerToken)).statusCode).toBe(403);
    expect((await admin('put', '/store-timings', managerToken).send({ openingTime: '10:00' })).statusCode).toBe(403);
  });

  it('updates the global timings with validation and an audit entry', async () => {
    const res = await admin('put', '/store-timings').send({ orderCutoffTime: '18:30', weeklyClosedDays: [0, 0] });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ orderCutoffTime: '18:30', weeklyClosedDays: [0] });
    expect(await prisma.auditLog.count({ where: { action: 'STORE_TIMINGS_UPDATED' } })).toBeGreaterThan(0);

    const badFormat = await admin('put', '/store-timings').send({ openingTime: '9 AM' });
    expect(badFormat.body).toMatchObject({ errorCode: 'INVALID_TIME_FORMAT' });
    const badOrder = await admin('put', '/store-timings').send({ orderCutoffTime: '08:00' });
    expect(badOrder.body).toMatchObject({ errorCode: 'INVALID_STORE_TIMINGS' });
    const allClosed = await admin('put', '/store-timings').send({ weeklyClosedDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(allClosed.body).toMatchObject({ errorCode: 'INVALID_CLOSED_DAYS' });

    await admin('put', '/store-timings').send({ orderCutoffTime: '19:00', weeklyClosedDays: [] });
  });

  it('lets a store use custom timings and switch back to global', async () => {
    const res = await admin('put', `/stores/${storeId}/timings`).send({
      useCustomTimings: true, openingTime: '10:00', orderCutoffTime: '18:00', pickupClosingTime: '20:00', weeklyClosedDays: [2],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ useCustomTimings: true, openingTime: '10:00', weeklyClosedDays: [2] });

    const back = await admin('put', `/stores/${storeId}/timings`).send({ useCustomTimings: false });
    expect(back.body.data.useCustomTimings).toBe(false);
  });

  it('adds and removes holidays for all stores or one store, rejecting duplicates', async () => {
    const all = await admin('post', '/store-holidays').send({ date: '2099-11-01', note: 'Diwali' });
    expect(all.statusCode).toBe(201);
    expect(all.body.data).toMatchObject({ date: '2099-11-01', storeId: null, storeName: null, note: 'Diwali' });
    createdHolidays.push(all.body.data.id);

    const one = await admin('post', '/store-holidays').send({ date: '2099-11-01', storeId });
    expect(one.statusCode).toBe(201);
    createdHolidays.push(one.body.data.id);

    expect((await admin('post', '/store-holidays').send({ date: '2099-11-01' })).statusCode).toBe(409);
    expect((await admin('post', '/store-holidays').send({ date: '2099-02-30' })).body).toMatchObject({ errorCode: 'INVALID_HOLIDAY_DATE' });

    expect((await admin('delete', `/store-holidays/${one.body.data.id}`)).statusCode).toBe(200);
    expect((await admin('delete', `/store-holidays/${one.body.data.id}`)).statusCode).toBe(404);
  });

  it('tells the customer the store is closed today on a holiday', async () => {
    const today = istParts(new Date()).date;
    const holiday = await admin('post', '/store-holidays').send({ date: today, note: 'Test Holiday' });
    createdHolidays.push(holiday.body.data.id);

    const res = await request(app).get('/api/v1/customer/store-timings').set('Authorization', `Bearer ${customerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ openToday: false, closedReason: 'Test Holiday', fulfillmentType: 'DELIVERY' });
    expect(res.body.data.message).toContain('Store is closed today (Test Holiday)');
    expect(res.body.data.fulfillmentDate > today).toBe(true);
  });

  it('requires a customer login and owns the address', async () => {
    expect((await request(app).get('/api/v1/customer/store-timings')).statusCode).toBe(401);
    const res = await request(app)
      .get('/api/v1/customer/store-timings?addressId=00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.statusCode).toBe(404);
  });
});
