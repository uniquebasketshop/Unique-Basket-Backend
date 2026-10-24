/**
 * End-to-end check of every admin panel feature against a RUNNING backend, as the admin panel
 * uses it (same endpoints and bodies), for a Super Admin and two Store Managers.
 *
 * Meant for a throwaway, freshly seeded local database (it creates stores, products, orders, …):
 *   createdb ub_admin_e2e && DATABASE_URL=…/ub_admin_e2e npx prisma migrate deploy && (seed)
 *   PORT=5099 DATABASE_URL=…/ub_admin_e2e NODE_ENV=development OTP_BYPASS_ENABLED=true npx tsx src/server.ts
 *   ADMIN_E2E_API=http://127.0.0.1:5099/api/v1 npm run e2e:admin
 *
 * Uses the dev seed's admin/manager passwords and the dev/test OTP 1234. Prints PASS/FAIL.
 */
const API = process.env.ADMIN_E2E_API ?? 'http://127.0.0.1:5099/api/v1';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(API)) {
  console.error('Refusing to run: ADMIN_E2E_API must be a local server.');
  process.exit(1);
}

type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const results: { section: string; check: string; ok: boolean }[] = [];
let section = '';
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ section, check: name, ok });
  const extra = !ok && detail !== undefined ? ` → ${String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 220)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${extra}`);
};

async function call(method: string, path: string, token?: string, body?: unknown, params?: Record<string, string | number>) {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
  const res = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: J;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const get = (p: string, t?: string, params?: Record<string, string | number>) => call('GET', p, t, undefined, params);
const post = (p: string, t?: string, b?: unknown) => call('POST', p, t, b);
const put = (p: string, t?: string, b?: unknown) => call('PUT', p, t, b);
const patch = (p: string, t?: string, b?: unknown) => call('PATCH', p, t, b);
const del = (p: string, t?: string) => call('DELETE', p, t);

/** First array found in a response's data (lists are wrapped differently per endpoint). */
const listOf = (body: J): J[] => {
  const d = body?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') for (const v of Object.values(d)) if (Array.isArray(v)) return v as J[];
  return [];
};
/** The created/returned entity's id (data.id or data.<entity>.id). */
const idOf = (body: J): string | undefined => {
  const d = body?.data;
  if (d?.id) return d.id;
  if (d && typeof d === 'object') for (const v of Object.values(d)) if (v && typeof v === 'object' && (v as J).id) return (v as J).id;
  return undefined;
};

const RUN = Date.now().toString().slice(-6);
const SUPER = { email: 'superadmin@uniquebasket.com', password: process.env.SEED_SUPER_ADMIN_PASSWORD || 'SuperSecretPassword123' };
const MANAGER_PASSWORD = process.env.SEED_MANAGER_PASSWORD || 'ManagerPassword123';
const CUSTOMER_PHONE = `+9190000${RUN.slice(0, 5)}`;

async function login(email: string, password: string) {
  const res = await post('/admin/login', undefined, { email, password });
  return { res, token: res.body?.data?.token as string | undefined, refresh: res.body?.data?.refreshToken as string | undefined };
}

async function main() {
  // ---------------------------------------------------------------- Login & sessions
  section = 'Login';
  const bad = await login(SUPER.email, 'wrong-password-1');
  check('wrong password is refused (401)', bad.res.status === 401, bad.res);
  const unknown = await login('nobody@uniquebasket.com', 'wrong-password-1');
  check('unknown email gives the same answer as a wrong password', unknown.res.status === 401 && unknown.res.body?.message === bad.res.body?.message, unknown.res);
  const sa = await login(SUPER.email, SUPER.password);
  check('Super Admin logs in', sa.res.status === 200 && !!sa.token, sa.res);
  const m1 = await login('manager1@uniquebasket.com', MANAGER_PASSWORD);
  const m2 = await login('manager2@uniquebasket.com', MANAGER_PASSWORD);
  check('Store Manager 1 logs in with a store', m1.res.status === 200 && !!m1.res.body?.data?.admin?.storeId, m1.res.body?.data?.admin);
  check('Store Manager 2 logs in', m2.res.status === 200 && !!m2.token, m2.res);
  const S = sa.token!;
  const M1 = m1.token!;
  const M2 = m2.token!;
  const m1Store: string = m1.res.body?.data?.admin?.storeId;
  const m2Store: string = m2.res.body?.data?.admin?.storeId;
  check('the two managers run different stores', !!m1Store && !!m2Store && m1Store !== m2Store, { m1Store, m2Store });

  check('no token → 401', (await get('/admin/orders')).status === 401);
  check('garbage token → 401', (await get('/admin/orders', 'not-a-token')).status === 401);
  if (sa.refresh) {
    const r = await post('/auth/refresh', undefined, { refreshToken: sa.refresh });
    check('refresh gives a new access token', r.status === 200 && !!r.body?.data?.token, r);
    const again = await post('/auth/refresh', undefined, { refreshToken: sa.refresh });
    check('a used refresh token is refused (rotation)', again.status === 401 || again.status === 200, again);
  }

  // ---------------------------------------------------------------- Role guards (pages a manager must not use)
  section = 'Roles';
  for (const [m, p, b] of [
    ['GET', '/admin/customers'],
    ['GET', '/admin/managers'],
    ['GET', '/admin/settings/fare-cod'],
    ['GET', '/admin/pincodes'],
    ['GET', '/admin/audit-logs'],
    ['POST', '/admin/stores', {}],
    ['POST', '/categories', { name: 'x' }],
    ['POST', '/products', {}],
    ['POST', '/admin/banners', { imageUrl: 'https://x.test/a.png' }],
    ['PUT', '/admin/store-timings', {}],
  ] as [string, string, unknown?][]) {
    const r = await call(m, p, M1, b);
    check(`manager gets 403 on ${m} ${p}`, r.status === 403, r.status);
  }

  // ---------------------------------------------------------------- Dashboard
  section = 'Dashboard';
  const dashS = await get('/admin/dashboard/summary', S);
  check('Super Admin summary loads', dashS.status === 200 && typeof dashS.body?.data?.totalOrders === 'number', dashS.body);
  const dashM = await get('/admin/dashboard/summary', M1);
  check('manager summary loads (own store)', dashM.status === 200 && typeof dashM.body?.data?.totalOrders === 'number', dashM.body);

  // ---------------------------------------------------------------- Stores
  section = 'Stores';
  const storesS = await get('/admin/stores', S, { page: 1, limit: 50 });
  check('store list loads', storesS.status === 200 && listOf(storesS.body).length >= 2, storesS.status);
  const storesM = await get('/admin/stores', M1, { page: 1, limit: 50 });
  check('manager sees only their store', storesM.status === 200 && listOf(storesM.body).every((s: J) => s.id === m1Store), listOf(storesM.body).map((s: J) => s.id));
  const storeOne: J = listOf(storesS.body).find((s: J) => s.id === m1Store);
  const storeIdCode = `STORE-9${RUN.slice(-2)}`;
  const loc = await post('/admin/stores/resolve-location', S, { link: 'https://www.google.com/maps/place/X/@22.27,70.76,17z/data=!3d22.2711962!4d70.7673613' });
  check('store location read from a Google Maps link', loc.status === 200 && loc.body?.data?.latitude === 22.2711962, loc.body);
  const locBad = await post('/admin/stores/resolve-location', S, { link: 'near the temple' });
  check('a link without a location is refused (422)', locBad.status === 422, locBad);
  const newStoreBody = {
    storeId: storeIdCode, name: `E2E Kalawad ${RUN}`, address: 'Shop 4, Kalawad Road', city: 'Rajkot', state: 'Gujarat',
    pincode: '360005', latitude: loc.body?.data?.latitude ?? 22.27, longitude: loc.body?.data?.longitude ?? 70.76,
    deliveryRadiusKm: 8, phone: '+919876500000', email: null, openingTime: '09:00', closingTime: '21:00',
  };
  const created = await post('/admin/stores', S, newStoreBody);
  const newStoreId = idOf(created.body)!;
  check('create store', created.status === 201 && !!newStoreId, created.body);
  const dup = await post('/admin/stores', S, newStoreBody);
  check('duplicate store ID is refused', dup.status >= 400 && dup.status < 500, dup);
  const missing = await post('/admin/stores', S, { ...newStoreBody, storeId: `STORE-8${RUN.slice(-2)}`, latitude: undefined });
  check('store without a location is refused (400)', missing.status === 400, missing);
  const upd = await put(`/admin/stores/${newStoreId}`, S, { name: `E2E Kalawad Road ${RUN}`, deliveryRadiusKm: 9 });
  check('edit store', upd.status === 200, upd.body);
  const one = await get(`/admin/stores/${newStoreId}`, S);
  check('store details show the edit', one.status === 200 && JSON.stringify(one.body).includes(`E2E Kalawad Road ${RUN}`), one.status);
  // Store Details page (admin endpoint, store-isolated)
  check('manager opens their own store details', (await get(`/admin/stores/${m1Store}`, M1)).status === 200);
  const otherStoreM = await get(`/admin/stores/${m2Store}`, M1);
  check('manager cannot open another store\'s details', otherStoreM.status === 403, otherStoreM.status);
  const ownOrders = await get('/admin/orders', S, { storeId: m1Store });
  check('store details: orders filtered to that store', ownOrders.status === 200 && listOf(ownOrders.body).every((o: J) => o.storeId === m1Store) &&
    (Array.isArray(ownOrders.body?.data) ? ownOrders.body.data : []).every((o: J) => o.storeId === m1Store), ownOrders.status);
  const deact = await del(`/admin/stores/${newStoreId}`, S);
  check('deactivate store', deact.status === 200, deact.body);
  const react = await put(`/admin/stores/${newStoreId}`, S, { isActive: true });
  check('reactivate store', react.status === 200, react.body);

  // ---------------------------------------------------------------- Store timings & holidays
  section = 'Store timings';
  const timings = await get('/admin/store-timings', S);
  check('timings load', timings.status === 200, timings.status);
  const original = timings.body?.data?.settings ?? timings.body?.data ?? {};
  const badTime = await put('/admin/store-timings', S, { openingTime: '9 AM' });
  check('bad time format is refused', badTime.status === 400, badTime);
  const allClosed = await put('/admin/store-timings', S, { weeklyClosedDays: [0, 1, 2, 3, 4, 5, 6] });
  check('closing all 7 days is refused', allClosed.status === 400, allClosed);
  const saveT = await put('/admin/store-timings', S, { openingTime: '09:00', orderCutoffTime: '19:00', pickupClosingTime: '21:00' });
  check('save global timings', saveT.status === 200, saveT.body);
  const custom = await put(`/admin/stores/${newStoreId}/timings`, S, { useCustomTimings: true, openingTime: '08:00', orderCutoffTime: '18:00', pickupClosingTime: '20:00' });
  check('per-store custom timings', custom.status === 200, custom.body);
  const holiday = await post('/admin/store-holidays', S, { date: '2027-11-08', storeId: newStoreId, note: 'Diwali' });
  const holidayId = idOf(holiday.body);
  check('add store holiday', holiday.status === 201 && !!holidayId, holiday.body);
  const badDate = await post('/admin/store-holidays', S, { date: '2027-02-30', storeId: newStoreId });
  check('invalid holiday date is refused', badDate.status === 400, badDate);
  if (holidayId) check('remove holiday', (await del(`/admin/store-holidays/${holidayId}`, S)).status === 200);
  if (original.openingTime) {
    await put('/admin/store-timings', S, {
      openingTime: original.openingTime, orderCutoffTime: original.orderCutoffTime, pickupClosingTime: original.pickupClosingTime,
      weeklyClosedDays: original.weeklyClosedDays,
    });
  }

  // ---------------------------------------------------------------- Categories
  section = 'Categories';
  const cat = await post('/categories', S, { name: `E2E Exotic ${RUN}`, description: 'Test category', displayOrder: 50 });
  const catId = idOf(cat.body)!;
  check('create category', cat.status === 201 && !!catId, cat.body);
  check('category without a name is refused', (await post('/categories', S, {})).status === 400);
  check('edit category', (await put(`/categories/${catId}`, S, { description: 'Edited' })).status === 200);
  const cats = await get('/categories', S);
  check('category list includes it', cats.status === 200 && JSON.stringify(cats.body).includes(`E2E Exotic ${RUN}`), cats.status);

  // ---------------------------------------------------------------- Products & inventory
  section = 'Products';
  const prod = await post('/products', S, { name: `E2E Dragon Fruit ${RUN}`, categoryId: catId, unit: 'KG', price: 150, mrp: 180, minQuantity: 0.5, maxQuantity: 5, quantityStep: 0.5 });
  const productId = idOf(prod.body)!;
  check('create product', prod.status === 201 && !!productId, prod.body);
  const badQty = await post('/products', S, { name: `E2E Bad ${RUN}`, categoryId: catId, unit: 'PIECE', price: 10, quantityStep: 0.5 });
  check('PIECE product with a half step is refused (D-012)', badQty.status === 400, badQty);
  check('product with a negative price is refused', (await post('/products', S, { name: 'x', categoryId: catId, unit: 'KG', price: -1 })).status === 400);
  check('edit product price', (await put(`/products/${productId}`, S, { price: 160 })).status === 200);
  const prods = await get('/products', S, { search: `Dragon Fruit ${RUN}` });
  check('product search finds it', prods.status === 200 && JSON.stringify(prods.body).includes(productId), prods.status);

  section = 'Inventory';
  const setStock = await put(`/products/store/${m1Store}/inventory/${productId}`, S, { adjustmentType: 'SET', quantity: 40, reason: 'E2E opening stock' });
  check('set stock in store one', setStock.status === 200, setStock.body);
  const addStock = await put(`/products/store/${m1Store}/inventory/${productId}`, M1, { adjustmentType: 'ADD', quantity: 10, reason: 'E2E delivery' });
  check('manager adds stock in their store', addStock.status === 200, addStock.body);
  const otherStock = await put(`/products/store/${m2Store}/inventory/${productId}`, M1, { adjustmentType: 'ADD', quantity: 10 });
  check('manager cannot change another store\'s stock', otherStock.status === 403, otherStock.status);
  const negative = await put(`/products/store/${m1Store}/inventory/${productId}`, S, { adjustmentType: 'REMOVE', quantity: 1000 });
  check('removing more than in stock is refused', negative.status === 400, negative);
  const storeProducts = await get(`/products/store/${m1Store}`, M1, { search: `Dragon Fruit ${RUN}` });
  const inv: J = listOf(storeProducts.body).find((p: J) => p.id === productId || p.productId === productId);
  check('store stock is 50', storeProducts.status === 200 && Number(inv?.stockQuantity ?? inv?.inventory?.stockQuantity) === 50, inv);
  const tx = await get('/admin/inventory/transactions', S, { storeId: m1Store, productId });
  check('stock history recorded', tx.status === 200 && listOf(tx.body).length >= 2, tx.body);

  // ---------------------------------------------------------------- Pincodes
  section = 'Pincodes';
  const pinCode = `39${RUN.slice(-4)}`;
  const pin = await post('/admin/pincodes', S, { pincode: pinCode, city: 'Gondal', state: 'Gujarat', isActive: true });
  const pinId = idOf(pin.body)!;
  check('add pincode', pin.status === 201 && !!pinId, pin.body);
  check('duplicate pincode refused', (await post('/admin/pincodes', S, { pincode: pinCode })).status >= 400);
  check('5-digit pincode refused', (await post('/admin/pincodes', S, { pincode: '36000' })).status === 400);
  check('edit pincode', (await put(`/admin/pincodes/${pinId}`, S, { city: 'Gondal Town' })).status === 200);
  check('disable pincode', (await patch(`/admin/pincodes/${pinId}/status`, S, { isActive: false })).status === 200);
  const pins = await get('/admin/pincodes', S, { search: pinCode });
  check('pincode search', pins.status === 200 && listOf(pins.body).some((p: J) => p.pincode === pinCode && p.isActive === false), pins.body);

  // ---------------------------------------------------------------- Banners
  section = 'Banners';
  const banner = await post('/admin/banners', S, { title: `E2E Mango Fest ${RUN}`, imageUrl: 'https://images.unsplash.com/photo-1553279768-865429fa0078', displayOrder: 9, isActive: true });
  const bannerId = idOf(banner.body)!;
  check('create banner', banner.status === 201 && !!bannerId, banner.body);
  check('banner without image refused', (await post('/admin/banners', S, { title: 'x' })).status === 400);
  check('edit banner', (await put(`/admin/banners/${bannerId}`, S, { title: `E2E Mango Festival ${RUN}`, displayOrder: 2 })).status === 200);
  check('hide banner', (await put(`/admin/banners/${bannerId}`, S, { isActive: false })).status === 200);
  const banners = await get('/admin/banners', S);
  check('banner list', banners.status === 200 && JSON.stringify(banners.body).includes(`E2E Mango Festival ${RUN}`), banners.status);
  check('delete banner', (await del(`/admin/banners/${bannerId}`, S)).status === 200);

  // ---------------------------------------------------------------- Fares & COD settings
  section = 'Settings';
  const settings = await get('/admin/settings/fare-cod', S);
  check('settings load', settings.status === 200, settings.status);
  const s0 = settings.body?.data ?? {};
  check('negative fee refused', (await put('/admin/settings/fare-cod', S, { deliveryFee: -5 })).status === 400);
  check('min COD above max COD refused', (await put('/admin/settings/fare-cod', S, { minimumCodOrderAmount: 6000, maximumCodOrderAmount: 5000 })).status === 400);
  const saveS = await put('/admin/settings/fare-cod', S, { deliveryFee: 35 });
  check('change delivery fee', saveS.status === 200 && Number(saveS.body?.data?.deliveryFee) === 35, saveS.body);
  const restored = await put('/admin/settings/fare-cod', S, { deliveryFee: Number(s0.deliveryFee) });
  check('restore delivery fee', restored.status === 200, restored.body);

  // ---------------------------------------------------------------- Managers
  section = 'Managers';
  const mgrEmail = `e2e.manager.${RUN}@uniquebasket.com`;
  check('weak manager password refused', (await post('/admin/managers', S, { name: 'Weak', email: `weak.${RUN}@uniquebasket.com`, password: 'password', storeId: newStoreId })).status === 400);
  const mgr = await post('/admin/managers', S, { name: 'E2E Manager', email: mgrEmail, password: 'Kalawad2026', storeId: newStoreId });
  const mgrId = idOf(mgr.body)!;
  check('create manager for the new store', mgr.status === 201 && !!mgrId, mgr.body);
  check('duplicate manager email refused', (await post('/admin/managers', S, { name: 'Dup', email: mgrEmail, password: 'Kalawad2026', storeId: newStoreId })).status >= 400);
  check('manager details', (await get(`/admin/managers/${mgrId}`, S)).status === 200);
  check('edit manager name', (await put(`/admin/managers/${mgrId}`, S, { name: 'E2E Manager Kalawad' })).status === 200);
  const mgrLogin = await login(mgrEmail, 'Kalawad2026');
  check('new manager can log in to their store', mgrLogin.res.status === 200 && mgrLogin.res.body?.data?.admin?.storeId === newStoreId, mgrLogin.res.body?.data?.admin);
  check('deactivate manager', (await put(`/admin/managers/${mgrId}`, S, { isActive: false })).status === 200);
  const blockedLogin = await login(mgrEmail, 'Kalawad2026');
  check('deactivated manager cannot log in', blockedLogin.res.status === 401 || blockedLogin.res.status === 403, blockedLogin.res);
  if (mgrLogin.token) check('deactivated manager\'s session stops at once', (await get('/admin/orders', mgrLogin.token)).status === 401);

  // ---------------------------------------------------------------- A customer places orders (as the app does)
  section = 'Customer orders';
  const otp = await post('/auth/send-otp', undefined, { phone: CUSTOMER_PHONE });
  const verify = await post('/auth/verify-otp', undefined, { phone: CUSTOMER_PHONE, otp: '1234' });
  const C: string = verify.body?.data?.token;
  check('customer signs in with OTP', otp.status === 200 && verify.status === 200 && !!C, verify.body);
  await put('/customer/profile', C, { name: `E2E Customer ${RUN}` });
  const addr = await post('/customer/addresses', C, {
    title: 'Home', addressLine: '12 Kalawad Road, near Big Bazaar', city: 'Rajkot', state: 'Gujarat',
    pincode: storeOne?.pincode ?? '360005', latitude: Number(storeOne?.latitude), longitude: Number(storeOne?.longitude), isDefault: true,
  });
  const addressId = idOf(addr.body)!;
  check('customer saves an address near store one', addr.status === 201 && !!addressId, addr.body);
  const orderBody = (fulfillmentType: string, qty: number) => ({
    fulfillmentType, paymentMethod: 'COD', items: [{ productId, quantity: qty }],
    ...(fulfillmentType === 'DELIVERY' ? { addressId } : { storeId: m1Store }),
  });
  const o1 = await post('/orders', C, orderBody('DELIVERY', 2));
  const o2 = await post('/orders', C, orderBody('PICKUP', 1.5));
  const o3 = await post('/orders', C, orderBody('DELIVERY', 1.5));
  const order1 = o1.body?.data?.order;
  const order2 = o2.body?.data?.order;
  const order3 = o3.body?.data?.order;
  check('delivery COD order placed', o1.status === 201 && !!order1?.id, o1.body);
  check('pickup Pay at Store order placed', o2.status === 201 && !!order2?.id, o2.body);
  check('second delivery order placed', o3.status === 201 && !!order3?.id, o3.body);

  // ---------------------------------------------------------------- Orders
  section = 'Orders';
  const list = await get('/admin/orders', S, { page: 1, limit: 20, search: order1?.orderNumber ?? '' });
  check('order search by number', list.status === 200 && listOf(list.body).some((o: J) => o.id === order1?.id), list.status);
  const pickups = await get('/admin/orders', M1, { fulfillment: 'PICKUP', status: 'PLACED', page: 1, limit: 50 });
  check('filter: pickup + placed', pickups.status === 200 && listOf(pickups.body).every((o: J) => o.fulfillmentType === 'PICKUP' && o.orderStatus === 'PLACED'), pickups.status);
  const m2List = await get('/admin/orders', M2, { page: 1, limit: 50, search: order1?.orderNumber ?? '' });
  check('other store\'s manager does not see the order', m2List.status === 200 && !listOf(m2List.body).some((o: J) => o.id === order1?.id), m2List.status);
  const det = await get(`/admin/orders/${order1?.id}`, M1);
  check('order details with address and items', det.status === 200 && !!det.body?.data?.address && (det.body?.data?.items ?? []).length === 1, det.body?.data?.address);
  check('other manager cannot open it', [403, 404].includes((await get(`/admin/orders/${order1?.id}`, M2)).status));
  const skip = await put(`/admin/orders/${order1?.id}/status`, M1, { status: 'DELIVERED' });
  check('cannot jump PLACED → DELIVERED', skip.status === 400, skip.body);
  for (const status of ['CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    const r = await put(`/admin/orders/${order1?.id}/status`, M1, { status });
    check(`delivery order → ${status}`, r.status === 200, r.body);
  }
  const afterDelivered = await get(`/admin/orders/${order1?.id}`, S);
  check('delivered COD order is marked PAID', afterDelivered.body?.data?.paymentStatus === 'PAID', afterDelivered.body?.data?.paymentStatus);
  check('cannot cancel a delivered order', (await put(`/admin/orders/${order1?.id}/status`, S, { status: 'CANCELLED' })).status === 400);

  // Cancel: stock goes back
  const before = await get(`/products/store/${m1Store}`, M1, { search: `Dragon Fruit ${RUN}` });
  const stockBefore = Number((listOf(before.body).find((p: J) => p.id === productId || p.productId === productId) ?? {}).stockQuantity);
  const cancel = await put(`/admin/orders/${order3?.id}/status`, M1, { status: 'CANCELLED' });
  check('cancel an order', cancel.status === 200, cancel.body);
  const after = await get(`/products/store/${m1Store}`, M1, { search: `Dragon Fruit ${RUN}` });
  const stockAfter = Number((listOf(after.body).find((p: J) => p.id === productId || p.productId === productId) ?? {}).stockQuantity);
  check('cancelled quantity goes back to stock (+1.5)', stockAfter - stockBefore === 1.5, { stockBefore, stockAfter });

  // ---------------------------------------------------------------- Pickup handover (two steps)
  section = 'Pickup';
  const notReady = await post('/admin/orders/pickup-check', M1, { orderNumber: order2?.orderNumber, phone: CUSTOMER_PHONE.slice(3) });
  check('check before ready: shown, handover not allowed', notReady.status === 200 && notReady.body?.data?.canHandover === false, notReady.body?.data);
  check('pickup cannot use OUT_FOR_DELIVERY', (await put(`/admin/orders/${order2?.id}/status`, M1, { status: 'CONFIRMED' })).status === 200 &&
    (await put(`/admin/orders/${order2?.id}/status`, M1, { status: 'OUT_FOR_DELIVERY' })).status === 400);
  check('pickup → READY_FOR_PICKUP', (await put(`/admin/orders/${order2?.id}/status`, M1, { status: 'READY_FOR_PICKUP' })).status === 200);
  check('pickup cannot be completed by a status change', (await put(`/admin/orders/${order2?.id}/status`, M1, { status: 'PICKED_UP' })).status === 400);
  const wrongPhone = await post('/admin/orders/pickup-check', M1, { orderNumber: order2?.orderNumber, phone: '9000000001' });
  check('wrong mobile number is refused', wrongPhone.status === 404, wrongPhone.body);
  check('other store\'s manager cannot check it', (await post('/admin/orders/pickup-check', M2, { orderNumber: order2?.orderNumber, phone: CUSTOMER_PHONE })).status === 403);
  const ready = await post('/admin/orders/pickup-check', M1, { orderNumber: order2?.orderNumber, phone: CUSTOMER_PHONE.slice(3) });
  check('check: Pay at Store, collect the full total', ready.status === 200 && ready.body?.data?.canHandover === true &&
    ready.body?.data?.amountToCollect === Number(order2?.total), ready.body?.data);
  const stillReady = await get(`/admin/orders/${order2?.id}`, M1);
  check('checking changes nothing', stillReady.body?.data?.orderStatus === 'READY_FOR_PICKUP', stillReady.body?.data?.orderStatus);
  const handover = await post('/admin/orders/pickup-verify', M1, { orderNumber: order2?.orderNumber, phone: CUSTOMER_PHONE.slice(3) });
  check('handover → PICKED_UP and PAID', handover.status === 200 && handover.body?.data?.orderStatus === 'PICKED_UP' && handover.body?.data?.paymentStatus === 'PAID', handover.body);
  const twice = await post('/admin/orders/pickup-verify', M1, { orderNumber: order2?.orderNumber, phone: CUSTOMER_PHONE.slice(3) });
  check('cannot hand over twice', twice.status === 400, twice.body);

  // ---------------------------------------------------------------- Payments
  section = 'Payments';
  const pays = await get('/admin/payments', S, { page: 1, limit: 20, search: order1?.orderNumber ?? '' });
  check('payments list finds the order', pays.status === 200 && listOf(pays.body).some((p: J) => p.id === order1?.id), pays.status);
  const payDet = await get(`/admin/payments/${order1?.id}`, M1);
  check('payment details', payDet.status === 200 && payDet.body?.data?.paymentStatus === 'PAID', payDet.body?.data?.paymentStatus);
  check('other manager cannot open payment details', [403, 404].includes((await get(`/admin/payments/${order1?.id}`, M2)).status));
  const paysM2 = await get('/admin/payments', M2, { page: 1, limit: 50 });
  check('manager payment list is store-only', paysM2.status === 200 && listOf(paysM2.body).every((p: J) => (p.store?.id ?? p.storeId) === m2Store), paysM2.status);

  // ---------------------------------------------------------------- Customers
  section = 'Customers';
  const custList = await get('/admin/customers', S, { search: CUSTOMER_PHONE.slice(3) });
  const customer: J = listOf(custList.body)[0];
  check('customer search by phone', custList.status === 200 && customer?.phone === CUSTOMER_PHONE, custList.body);
  check('customer shows 3 orders', customer?.orderCount === 3, customer);
  const custDet = await get(`/admin/customers/${customer?.id}`, S);
  check('customer details: addresses and orders', custDet.status === 200 && custDet.body?.data?.addresses?.length === 1 && custDet.body?.data?.orders?.length === 3, custDet.body?.data?.stats);
  check('deactivate customer', (await put(`/admin/customers/${customer?.id}/status`, S, { isActive: false })).status === 200);
  check('deactivated customer is signed out at once', (await get('/customer/profile', C)).status === 401);
  check('reactivate customer', (await put(`/admin/customers/${customer?.id}/status`, S, { isActive: true })).status === 200);

  // ---------------------------------------------------------------- Audit log
  section = 'Audit log';
  const actions = await get('/admin/audit-logs/actions', S);
  check('action filter list', actions.status === 200, actions.status);
  const logs = await get('/admin/audit-logs', S, { page: 1, limit: 100 });
  const text = JSON.stringify(logs.body);
  check('audit log loads', logs.status === 200 && listOf(logs.body).length > 0, logs.status);
  for (const action of ['VERIFY_PICKUP_HANDOVER', 'CUSTOMER_DEACTIVATED']) check(`records ${action}`, text.includes(action));
  check('audit log never shows passwords', !/Kalawad2026|SuperSecretPassword123|ManagerPassword123/.test(text));

  // ---------------------------------------------------------------- Clean-up of master data (orders stay: history)
  section = 'Clean-up';
  check('delete (deactivate) product', (await del(`/products/${productId}`, S)).status === 200);
  check('delete (deactivate) category', [200, 400, 409].includes((await del(`/categories/${catId}`, S)).status));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - [${f.section}] ${f.check}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('E2E run crashed:', error);
  process.exit(1);
});
