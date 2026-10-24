import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/errors';
import { resolveDeliveryStore } from './orderService';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Store timings, weekly closed days and holidays (D-015). All times are India time (IST, UTC+5:30).
 * Orders are never blocked: the schedule only decides when an order is delivered / ready for pickup.
 * - Before opening → today after opening; until the order cut-off → today; after the cut-off → next open day.
 * - Closed days (weekly off or holiday) roll to the next open day.
 * Nothing is stored on the order; the date is worked out when needed.
 */

export interface StoreTimings {
  openingTime: string; // HH:MM
  orderCutoffTime: string; // HH:MM, last order served the same day
  pickupClosingTime: string; // HH:MM, pickup counter closes
  weeklyClosedDays: number[]; // 0 = Sunday … 6 = Saturday
}

export interface HolidayEntry {
  date: string; // YYYY-MM-DD
  note: string | null;
}

export type FulfillmentKind = 'DELIVERY' | 'PICKUP';

export const DEFAULT_TIMINGS: StoreTimings = {
  openingTime: '09:00',
  orderCutoffTime: '19:00',
  pickupClosingTime: '21:00',
  weeklyClosedDays: [],
};

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MAX_LOOKAHEAD_DAYS = 120;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IST calendar date (YYYY-MM-DD) and time (HH:MM) for an instant. */
export function istParts(now: Date): { date: string; time: string } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 16) };
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** "09:00" → "9:00 AM". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "2026-11-02" → "Mon, 2 Nov". */
export function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface Availability {
  fulfillmentType: FulfillmentKind;
  today: string;
  openToday: boolean;
  /** Why the store is closed today (holiday note or "Weekly off"), else null. */
  closedReason: string | null;
  /** Date the order will be delivered / ready (YYYY-MM-DD, IST). */
  fulfillmentDate: string;
  fulfillmentDay: 'TODAY' | 'TOMORROW' | 'LATER';
  /** Short label for checkout, e.g. "Tomorrow after 9:00 AM". */
  label: string;
  /** Banner text for the app, or null when ordering now is served normally today. */
  message: string | null;
  timings: StoreTimings;
}

/** Pure schedule rules (D-015). */
export function computeAvailability(
  timings: StoreTimings,
  holidays: HolidayEntry[],
  now: Date,
  fulfillmentType: FulfillmentKind = 'DELIVERY',
): Availability {
  const { date: today, time } = istParts(now);
  const holidayByDate = new Map(holidays.map((h) => [h.date, h]));
  const isOpenDay = (date: string) => !timings.weeklyClosedDays.includes(weekdayOf(date)) && !holidayByDate.has(date);

  const openToday = isOpenDay(today);
  const holidayToday = holidayByDate.get(today);
  const closedReason = openToday ? null : holidayToday ? holidayToday.note || 'Holiday' : 'Weekly off';

  let fulfillmentDate = today;
  if (!openToday || time >= timings.orderCutoffTime) {
    fulfillmentDate = addDays(today, 1);
    for (let i = 0; i < MAX_LOOKAHEAD_DAYS && !isOpenDay(fulfillmentDate); i++) fulfillmentDate = addDays(fulfillmentDate, 1);
  }

  const tomorrow = addDays(today, 1);
  const fulfillmentDay = fulfillmentDate === today ? 'TODAY' : fulfillmentDate === tomorrow ? 'TOMORROW' : 'LATER';
  const dayText = fulfillmentDay === 'TODAY' ? 'today' : fulfillmentDay === 'TOMORROW' ? 'tomorrow' : `on ${formatDate(fulfillmentDate)}`;
  const opens = formatTime(timings.openingTime);
  const beforeOpening = fulfillmentDay === 'TODAY' && time < timings.openingTime;
  const isPickup = fulfillmentType === 'PICKUP';

  // Label for checkout
  const dayLabel = fulfillmentDay === 'TODAY' ? 'Today' : fulfillmentDay === 'TOMORROW' ? 'Tomorrow' : formatDate(fulfillmentDate);
  let label: string;
  if (isPickup) {
    label = fulfillmentDay === 'TODAY' && !beforeOpening
      ? `Today, until ${formatTime(timings.pickupClosingTime)}`
      : `${dayLabel} from ${opens}`;
  } else {
    label = fulfillmentDay === 'TODAY' && !beforeOpening ? 'Today' : `${dayLabel} after ${opens}`;
  }

  // Banner message
  const outcome = isPickup ? `ready for pickup ${dayText} from ${opens}` : `delivered ${dayText} after ${opens}`;
  let message: string | null = null;
  if (!openToday) {
    message = `Store is closed today${holidayToday?.note ? ` (${holidayToday.note})` : ''}. Orders placed now will be ${outcome}.`;
  } else if (fulfillmentDay !== 'TODAY') {
    message = `Orders placed after ${formatTime(timings.orderCutoffTime)} will be ${outcome}.`;
  } else if (beforeOpening) {
    message = `Store opens at ${opens}. Orders placed now will be ${outcome}.`;
  }

  return { fulfillmentType, today, openToday, closedReason, fulfillmentDate, fulfillmentDay, label, message, timings };
}

// ---------- Loading ----------

export async function loadGlobalTimings(db: Db = prisma): Promise<StoreTimings> {
  const s = await db.deliverySettings.findFirst();
  if (!s) return { ...DEFAULT_TIMINGS };
  return {
    openingTime: s.storeOpeningTime,
    orderCutoffTime: s.orderCutoffTime,
    pickupClosingTime: s.pickupClosingTime,
    weeklyClosedDays: s.weeklyClosedDays,
  };
}

/** Effective timings for a store: its own when useCustomTimings, else the global ones. */
export async function loadStoreTimings(storeId: string | null, db: Db = prisma): Promise<StoreTimings> {
  if (storeId) {
    const store = await db.store.findUnique({ where: { id: storeId } });
    const valid = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (store?.useCustomTimings && [store.openingTime, store.orderCutoffTime, store.closingTime].every(valid)) {
      return {
        openingTime: store.openingTime,
        orderCutoffTime: store.orderCutoffTime,
        pickupClosingTime: store.closingTime,
        weeklyClosedDays: store.weeklyClosedDays,
      };
    }
  }
  return loadGlobalTimings(db);
}

/** Holidays from `fromDate` on that apply to the store (store-specific + all-store ones). */
export async function loadHolidays(storeId: string | null, fromDate: string, db: Db = prisma): Promise<HolidayEntry[]> {
  const rows = await db.storeHoliday.findMany({
    where: {
      date: { gte: new Date(`${fromDate}T00:00:00Z`), lte: new Date(`${addDays(fromDate, MAX_LOOKAHEAD_DAYS)}T00:00:00Z`) },
      OR: storeId ? [{ storeId: null }, { storeId }] : [{ storeId: null }],
    },
    orderBy: { date: 'asc' },
  });
  return rows.map((h) => ({ date: h.date.toISOString().slice(0, 10), note: h.note }));
}

export async function getAvailability(storeId: string | null, fulfillmentType: FulfillmentKind, now = new Date(), db: Db = prisma) {
  const timings = await loadStoreTimings(storeId, db);
  const holidays = await loadHolidays(storeId, istParts(now).date, db);
  return computeAvailability(timings, holidays, now, fulfillmentType);
}

// ---------- Admin management ----------

function assertTimingsOrder(t: StoreTimings) {
  if (!(t.openingTime < t.orderCutoffTime && t.orderCutoffTime <= t.pickupClosingTime)) {
    throw new AppError(
      400,
      'INVALID_STORE_TIMINGS',
      'Opening time must be before the last order time, and the last order time must not be after the pickup closing time.',
    );
  }
}

export type TimingsChanges = Partial<StoreTimings>;

export async function updateGlobalTimings(actorId: string | undefined, changes: TimingsChanges) {
  const merged = { ...(await loadGlobalTimings()), ...stripUndefined(changes) };
  assertTimingsOrder(merged);
  const data = {
    storeOpeningTime: merged.openingTime,
    orderCutoffTime: merged.orderCutoffTime,
    pickupClosingTime: merged.pickupClosingTime,
    weeklyClosedDays: merged.weeklyClosedDays,
  };
  await prisma.$transaction(async (tx) => {
    const existing = await tx.deliverySettings.findFirst();
    if (existing) await tx.deliverySettings.update({ where: { id: existing.id }, data });
    else await tx.deliverySettings.create({ data });
    await tx.auditLog.create({
      data: { adminUserId: actorId, action: 'STORE_TIMINGS_UPDATED', details: `Updated global store timings: ${describe(merged)}` },
    });
  });
  return merged;
}

export async function updateStoreCustomTimings(
  actorId: string | undefined,
  storeId: string,
  changes: TimingsChanges & { useCustomTimings?: boolean },
) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
  const merged: StoreTimings = {
    openingTime: changes.openingTime ?? store.openingTime,
    orderCutoffTime: changes.orderCutoffTime ?? store.orderCutoffTime,
    pickupClosingTime: changes.pickupClosingTime ?? store.closingTime,
    weeklyClosedDays: changes.weeklyClosedDays ?? store.weeklyClosedDays,
  };
  const useCustomTimings = changes.useCustomTimings ?? store.useCustomTimings;
  if (useCustomTimings) assertTimingsOrder(merged);

  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { id: storeId },
      data: {
        useCustomTimings,
        openingTime: merged.openingTime,
        orderCutoffTime: merged.orderCutoffTime,
        closingTime: merged.pickupClosingTime,
        weeklyClosedDays: merged.weeklyClosedDays,
      },
    });
    await tx.auditLog.create({
      data: {
        adminUserId: actorId,
        action: 'STORE_TIMINGS_UPDATED',
        details: useCustomTimings
          ? `Store ${store.storeId} uses custom timings: ${describe(merged)}`
          : `Store ${store.storeId} uses the global timings`,
      },
    });
  });
  return { storeId, useCustomTimings, ...merged };
}

export async function getTimingsOverview(today = istParts(new Date()).date) {
  const [global, stores, holidays] = await Promise.all([
    loadGlobalTimings(),
    prisma.store.findMany({ orderBy: { storeId: 'asc' } }),
    prisma.storeHoliday.findMany({
      where: { date: { gte: new Date(`${today}T00:00:00Z`) } },
      include: { store: true },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  return {
    global,
    stores: stores.map((s) => ({
      id: s.id,
      storeId: s.storeId,
      name: s.name,
      isActive: s.isActive,
      useCustomTimings: s.useCustomTimings,
      openingTime: s.openingTime,
      orderCutoffTime: s.orderCutoffTime,
      pickupClosingTime: s.closingTime,
      weeklyClosedDays: s.weeklyClosedDays,
    })),
    holidays: holidays.map(toHolidayDto),
  };
}

function toHolidayDto(h: { id: string; date: Date; note: string | null; storeId: string | null; store?: { name: string; storeId: string } | null }) {
  return {
    id: h.id,
    date: h.date.toISOString().slice(0, 10),
    note: h.note,
    storeId: h.storeId,
    storeName: h.store ? `${h.store.name} (${h.store.storeId})` : null,
  };
}

export async function addHoliday(actorId: string | undefined, input: { date: string; storeId?: string | null; note?: string | null }) {
  const storeId = input.storeId ?? null;
  const store = storeId ? await prisma.store.findUnique({ where: { id: storeId } }) : null;
  if (storeId && !store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
  const date = new Date(`${input.date}T00:00:00Z`);
  const duplicate = await prisma.storeHoliday.findFirst({ where: { date, storeId } });
  if (duplicate) throw new AppError(409, 'DUPLICATE_HOLIDAY', `A holiday on ${input.date} already exists for ${store ? store.name : 'all stores'}.`);

  const created = await prisma.$transaction(async (tx) => {
    const holiday = await tx.storeHoliday.create({ data: { date, storeId, note: input.note ?? null }, include: { store: true } });
    await tx.auditLog.create({
      data: {
        adminUserId: actorId,
        action: 'STORE_HOLIDAY_ADDED',
        details: `Added holiday ${input.date}${input.note ? ` (${input.note})` : ''} for ${store ? store.storeId : 'all stores'}`,
      },
    });
    return holiday;
  });
  return toHolidayDto(created);
}

export async function removeHoliday(actorId: string | undefined, id: string) {
  const holiday = await prisma.storeHoliday.findUnique({ where: { id }, include: { store: true } });
  if (!holiday) throw new AppError(404, 'HOLIDAY_NOT_FOUND', 'Holiday not found.');
  await prisma.$transaction(async (tx) => {
    await tx.storeHoliday.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        adminUserId: actorId,
        action: 'STORE_HOLIDAY_REMOVED',
        details: `Removed holiday ${holiday.date.toISOString().slice(0, 10)} for ${holiday.store ? holiday.store.storeId : 'all stores'}`,
      },
    });
  });
}

const stripUndefined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, value]) => value !== undefined)) as Partial<T>;

const describe = (t: StoreTimings) =>
  `opens ${t.openingTime}, last order ${t.orderCutoffTime}, pickup until ${t.pickupClosingTime}, closed days [${t.weeklyClosedDays.join(',')}]`;

/**
 * Availability for a customer (D-015). DELIVERY with an address uses the store that would serve it;
 * PICKUP uses the chosen store; otherwise (or when no store covers the address) the global timings.
 */
export async function getCustomerAvailability(
  userId: string,
  query: { fulfillmentType?: string; addressId?: string; storeId?: string },
  now = new Date(),
) {
  const fulfillmentType: FulfillmentKind = query.fulfillmentType === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
  let storeId: string | null = null;
  if (fulfillmentType === 'DELIVERY' && query.addressId) {
    const address = await prisma.userAddress.findUnique({ where: { id: query.addressId } });
    if (!address || address.userId !== userId) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Delivery address not found.');
    const store = await resolveDeliveryStore(prisma, address);
    storeId = store?.id ?? null;
  } else if (fulfillmentType === 'PICKUP' && query.storeId) {
    const store = await prisma.store.findUnique({ where: { id: query.storeId } });
    if (!store || !store.isActive) throw new AppError(400, 'STORE_UNAVAILABLE', 'Selected store is inactive or unavailable.');
    storeId = store.id;
  }
  return getAvailability(storeId, fulfillmentType, now);
}
