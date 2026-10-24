/**
 * End-to-end check of ordering and payments against the RUNNING local backend
 * (http://localhost:5001), the local dev database and the real Cashfree SANDBOX.
 *
 *   1. npm run dev        (in another terminal; Cashfree sandbox keys in .env)
 *   2. npm run e2e:sandbox
 *
 * Creates orders for a dedicated test customer (+91 90000 99911): COD delivery lifecycle,
 * pickup handover, online success, refund, failure + retry, switch to cash, 15-minute expiry
 * (back-dates its own test order), cash cancellation and safety rules. Prints PASS/FAIL.
 * Refuses to run against production keys or a non-local database. Uses the dev seed's admin
 * and manager passwords.
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { CashfreeClient, getCashfreeConfig } from '../src/services/payments/cashfreeClient';

const API = 'http://localhost:5001/api/v1';

// Safety: sandbox keys and a database on this machine only
const cfConfig = getCashfreeConfig();
const dbHost = (() => { try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return ''; } })();
if (!cfConfig || cfConfig.environment !== 'SANDBOX' || !['localhost', '127.0.0.1', '::1'].includes(dbHost)) {
  console.error('Refusing to run: needs Cashfree SANDBOX keys in .env and a local DATABASE_URL.');
  process.exit(1);
}
const PHONE = '+919000099911';
const cf = new CashfreeClient(cfConfig);
const db = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c TimeZone=UTC' });

type J = any;
const results: { scenario: string; check: string; ok: boolean; detail?: string }[] = [];
let scenario = '';
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ scenario, check: name, ok, detail: detail === undefined ? undefined : String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 160) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${!ok && detail !== undefined ? ` → ${String(typeof detail === 'object' ? JSON.stringify(detail) : detail).slice(0, 200)}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: J = undefined;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** Pays a Cashfree sandbox session the way a UPI app would (collect with a test UPI id). */
async function sandboxPay(paymentSessionId: string, upiId: 'testsuccess@gocash' | 'testfailure@gocash') {
  const config = getCashfreeConfig()!;
  const res = await fetch(`${config.baseUrl}/orders/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-version': config.apiVersion },
    body: JSON.stringify({ payment_session_id: paymentSessionId, payment_method: { upi: { channel: 'collect', upi_id: upiId } } }),
  });
  return res.status;
}

async function pollStatus(orderId: string, token: string, until: (d: J) => boolean, maxMs = 90_000) {
  const start = Date.now();
  let last: J;
  while (Date.now() - start < maxMs) {
    last = (await call('GET', `/payments/orders/${orderId}/status`, token)).body?.data;
    if (last && until(last)) return { data: last, ms: Date.now() - start };
    await sleep(3000);
  }
  return { data: last, ms: Date.now() - start };
}

const stockOf = async (storeId: string, productId: string) =>
  Number((await db.query('select stock_quantity from store_inventory where store_id=$1 and product_id=$2', [storeId, productId])).rows[0]?.stock_quantity ?? NaN);

async function main() {
  // ---------- Setup ----------
  scenario = 'Setup';
  const health = await call('GET', '/../../health');
  check('backend is up', health.status === 200, health.status);

  await call('POST', '/auth/send-otp', undefined, { phone: '9000099911' });
  const login = await call('POST', '/auth/verify-otp', undefined, { phone: '9000099911', otp: '1234' });
  check('customer OTP login (10-digit input normalised)', login.status === 200 && login.body.data.user.phone === PHONE, login.body);
  const token: string = login.body.data.token;
  await call('PUT', '/customer/profile', token, { name: 'E2E Tester' });

  const admin = await call('POST', '/admin/login', undefined, { email: 'superadmin@uniquebasket.com', password: 'SuperSecretPassword123' });
  check('super admin login', admin.status === 200, admin.body?.message);
  const adminToken: string = admin.body.data.token;
  const mgr = await call('POST', '/admin/login', undefined, { email: 'manager1@uniquebasket.com', password: 'ManagerPassword123' });
  check('store manager login', mgr.status === 200, mgr.body?.message);
  const managerToken: string = mgr.body.data.token;
  const storeId: string = mgr.body.data.admin.storeId;

  const settings = (await call('GET', '/customer/delivery-settings')).body.data;
  check('online payment offered (Cashfree configured)', settings.onlinePaymentAvailable === true, settings);
  const store = (await call('GET', `/stores/${storeId}`, token)).body.data;

  const products: J[] = (await call('GET', `/products/store/${storeId}`, token)).body.data;
  const usable = products.filter((p) => p.stockQuantity >= 30 && Number(p.price) > 0 && Number(p.price) <= 200 && !p.minQuantity);
  check('store has products in stock', usable.length >= 2, usable.length);
  const [p1, p2] = usable;
  const qty = (p: J) => Math.max(1, Math.ceil(260 / Number(p.price))); // enough for the ₹199 minimum

  // Delivery address at the store's location (serviceable, location confirmed)
  const addr = await call('POST', '/customer/addresses', token, {
    title: 'Home', addressLine: 'E2E Street 1', city: store.city, state: store.state, pincode: store.pincode,
    latitude: Number(store.latitude), longitude: Number(store.longitude),
  });
  check('add delivery address', addr.status === 201, addr.body);
  const addressId: string = addr.body.data.address.id;

  const placeOrder = (body: J, key = randomUUID()) => call('POST', '/orders', token, body, { 'Idempotency-Key': key });
  const orderRow = async (id: string) => (await db.query('select * from orders where id=$1', [id])).rows[0];

  // ---------- A. Cash on Delivery, full delivery lifecycle ----------
  scenario = 'A. COD delivery';
  await call('POST', '/cart/items', token, { productId: p1.id, quantity: qty(p1) });
  await call('POST', '/cart/items', token, { productId: p2.id, quantity: 1 });
  const cart = (await call('GET', '/cart', token)).body.data;
  check('cart has 2 lines', cart.items?.length === 2, cart.items?.length);
  const s1 = await stockOf(storeId, p1.id);
  const keyA = randomUUID();
  const items = [{ productId: p1.id, quantity: qty(p1) }, { productId: p2.id, quantity: 1 }];
  const a = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'COD', items }, keyA);
  check('order placed (201)', a.status === 201, a.body);
  const A = a.body.data.order;
  const expectedTotal = cart.subtotal + cart.deliveryFee + cart.codCharge;
  check('total = cart subtotal + delivery fee + COD charge (server-priced)', Math.abs(A.total - expectedTotal) < 0.01, { order: A.total, expectedTotal });
  check('no payment session for COD', a.body.data.payment === undefined, a.body.data);
  check('stock taken', (await stockOf(storeId, p1.id)) === s1 - qty(p1), { before: s1, after: await stockOf(storeId, p1.id) });
  check('server cart emptied', ((await call('GET', '/cart', token)).body.data.items ?? []).length === 0);
  const aRetry = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'COD', items }, keyA);
  check('retry with same Idempotency-Key returns same order (200)', aRetry.status === 200 && aRetry.body.data.order.id === A.id, aRetry.status);
  for (const next of ['CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    const r = await call('PUT', `/admin/orders/${A.id}/status`, managerToken, { status: next });
    check(`manager sets ${next}`, r.status === 200, r.body?.message);
  }
  const aDone = await orderRow(A.id);
  check('delivered COD order is marked PAID', aDone.order_status === 'DELIVERED' && aDone.payment_status === 'PAID', aDone);
  const notes = (await call('GET', '/notifications', token)).body.data;
  const noteList: J[] = notes.notifications ?? notes;
  check('customer got status notifications', noteList.filter((n) => n.orderId === A.id).length >= 3, noteList.length);

  // ---------- B. Store Pickup, Pay at Store ----------
  scenario = 'B. Pickup, Pay at Store';
  const b = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId: p2.id, quantity: 1 }] });
  const B = b.body.data.order;
  check('pickup order placed with no delivery fee, no COD charge, no minimum', b.status === 201 && B.deliveryFee === 0 && B.codCharge === 0 && B.total === Number(p2.price), B);
  await call('PUT', `/admin/orders/${B.id}/status`, managerToken, { status: 'CONFIRMED' });
  await call('PUT', `/admin/orders/${B.id}/status`, managerToken, { status: 'READY_FOR_PICKUP' });
  const direct = await call('PUT', `/admin/orders/${B.id}/status`, managerToken, { status: 'PICKED_UP' });
  check('PICKED_UP only via verification (D-006)', direct.status === 400, direct.body?.errorCode);
  const wrongPhone = await call('POST', '/admin/orders/pickup-verify', managerToken, { orderNumber: B.orderNumber, phone: '9999999999' });
  check('handover refused with the wrong phone', wrongPhone.status === 404, wrongPhone.status);
  const verify = await call('POST', '/admin/orders/pickup-verify', managerToken, { orderNumber: B.orderNumber.replace('#', ''), phone: '9000099911' });
  check('handover with order number + phone', verify.status === 200, verify.body?.message);
  const bDone = await orderRow(B.id);
  check('picked up and PAID', bDone.order_status === 'PICKED_UP' && bDone.payment_status === 'PAID', bDone);

  // ---------- C. Online payment success (delivery) ----------
  scenario = 'C. Online success';
  const sC = await stockOf(storeId, p1.id);
  const c = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'ONLINE', items: [{ productId: p1.id, quantity: qty(p1) }] });
  const C = c.body.data.order;
  check('online order placed with a Cashfree session', c.status === 201 && c.body.data.payment?.paymentSessionId && c.body.data.payment.environment === 'SANDBOX', c.body.data.payment);
  check('online order has no COD charge', C.codCharge === 0, C.codCharge);
  const cfOrder = await cf.getOrder(C.id);
  check('Cashfree has the order with our server total', Number(cfOrder.order_amount) === C.total && cfOrder.order_status === 'ACTIVE', cfOrder);
  check('not paid yet', (await orderRow(C.id)).payment_status === 'PENDING');
  check('sandbox UPI payment accepted', (await sandboxPay(c.body.data.payment.paymentSessionId, 'testsuccess@gocash')) === 200);
  const paidC = await pollStatus(C.id, token, (d) => d.paymentStatus === 'PAID');
  check(`status check confirms PAID (after ${Math.round(paidC.ms / 1000)}s)`, paidC.data?.paymentStatus === 'PAID', paidC.data);
  check('paid order stays PLACED until the store confirms (D-022)', paidC.data?.orderStatus === 'PLACED', paidC.data?.orderStatus);
  const adminC = (await call('GET', `/admin/orders/${C.id}`, adminToken)).body.data;
  check('admin sees payment PAID via upi with gateway ids, no secrets', adminC.payments?.[0]?.gatewayStatus === 'PAID' && adminC.payments[0].paymentMethod === 'upi' && !!adminC.payments[0].gatewayPaymentId && !/secret|signature/i.test(JSON.stringify(adminC)), adminC.payments);
  check('confirm paid online order', (await call('PUT', `/admin/orders/${C.id}/status`, managerToken, { status: 'CONFIRMED' })).status === 200);

  // ---------- D. Store cancels the paid order → automatic refund ----------
  scenario = 'D. Refund';
  const cancelC = await call('PUT', `/admin/orders/${C.id}/status`, adminToken, { status: 'CANCELLED' });
  check('store cancels paid order', cancelC.status === 200, cancelC.body?.message);
  check('stock put back', (await stockOf(storeId, p1.id)) === sC, { before: sC, after: await stockOf(storeId, p1.id) });
  let refund: J;
  for (let i = 0; i < 20; i++) {
    refund = (await call('GET', `/admin/payments/${C.id}`, adminToken)).body.data.refunds?.[0];
    if (refund?.status === 'SUCCESS') break;
    await sleep(5000);
  }
  check('refund created at Cashfree for the full amount', !!refund && Number(refund.amount) === C.total && !!refund.gatewayRefundId, refund);
  check('refund completed (or still processing in sandbox)', ['SUCCESS', 'PENDING'].includes(refund?.status), refund?.status);
  const custC = (await call('GET', `/orders/${C.id}`, token)).body.data;
  check('customer sees refund on the order', custC.refunds?.length === 1, custC.refunds);
  if (refund?.status === 'SUCCESS') check('order payment REFUNDED', (await orderRow(C.id)).payment_status === 'REFUNDED');

  // ---------- E. Online payment fails, then succeeds on retry ----------
  scenario = 'E. Fail then retry';
  const e = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'ONLINE', items: [{ productId: p2.id, quantity: 1 }] });
  const E = e.body.data.order;
  await sandboxPay(e.body.data.payment.paymentSessionId, 'testfailure@gocash');
  const failed = await pollStatus(E.id, token, (d) => d.lastAttemptStatus === 'FAILED');
  check(`failure reported, order still payable (after ${Math.round(failed.ms / 1000)}s)`, failed.data?.lastAttemptStatus === 'FAILED' && failed.data?.paymentStatus === 'PENDING' && !!failed.data?.payBy, failed.data);
  const again = await call('POST', `/payments/orders/${E.id}/session`, token);
  check('"Try again" gets a session for the same Cashfree order', again.status === 200 && again.body.data.payment.gatewayOrderId === E.id, again.body);
  await sandboxPay(again.body.data.payment.paymentSessionId, 'testsuccess@gocash');
  const paidE = await pollStatus(E.id, token, (d) => d.paymentStatus === 'PAID');
  check(`retry paid (after ${Math.round(paidE.ms / 1000)}s)`, paidE.data?.paymentStatus === 'PAID', paidE.data);
  check('"Pay with cash" refused once paid', (await call('POST', `/payments/orders/${E.id}/switch-to-cash`, token)).body.errorCode === 'ORDER_ALREADY_PAID');

  // ---------- F. Pay with cash instead ----------
  scenario = 'F. Switch to cash';
  const f = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'ONLINE', items: [{ productId: p1.id, quantity: qty(p1) }] });
  const F = f.body.data.order;
  const sw = await call('POST', `/payments/orders/${F.id}/switch-to-cash`, token);
  check('switched to Cash on Delivery with the COD charge added', sw.status === 200 && sw.body.data.order.paymentMethod === 'COD' && sw.body.data.order.total === F.total + settings.codCharge, sw.body.data?.order);
  const cfF = await cf.getOrder(F.id);
  check('Cashfree order stopped (cannot be paid now)', ['TERMINATED', 'TERMINATION_REQUESTED'].includes(cfF.order_status), cfF.order_status);
  check('no more online session for it', (await call('POST', `/payments/orders/${F.id}/session`, token)).body.errorCode === 'NOT_AN_ONLINE_ORDER');

  // ---------- G. Unpaid online order expires after 15 minutes ----------
  scenario = 'G. 15-minute expiry';
  const sG = await stockOf(storeId, p2.id);
  const g = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'ONLINE', items: [{ productId: p2.id, quantity: 2 }] });
  const G = g.body.data.order;
  check('stock held while unpaid', (await stockOf(storeId, p2.id)) === sG - 2);
  const details = (await call('GET', `/orders/${G.id}`, token)).body.data;
  check('order shows pay-by time ~15 min ahead', Math.abs(new Date(details.paymentDueBy).getTime() - Date.now() - 15 * 60e3) < 60e3, details.paymentDueBy);
  // Pretend it was placed 16 minutes ago, then wait for the payment job (runs every minute)
  await db.query("update orders set created_at = now() - interval '16 minutes' where id=$1", [G.id]);
  let gRow: J;
  for (let i = 0; i < 25; i++) {
    gRow = await orderRow(G.id);
    if (gRow.order_status === 'CANCELLED') break;
    await sleep(5000);
  }
  check('job cancelled the unpaid order', gRow.order_status === 'CANCELLED' && gRow.payment_status === 'FAILED', gRow && { status: gRow.order_status, pay: gRow.payment_status });
  check('stock released', (await stockOf(storeId, p2.id)) === sG, { before: sG, after: await stockOf(storeId, p2.id) });
  const cfG = await cf.getOrder(G.id);
  check('Cashfree order stopped', ['TERMINATED', 'TERMINATION_REQUESTED'].includes(cfG.order_status), cfG.order_status);
  check('"Pay now" no longer possible', (await call('POST', `/payments/orders/${G.id}/session`, token)).body.errorCode === 'PAYMENT_WINDOW_CLOSED');

  // ---------- H. Store cancels a cash order ----------
  scenario = 'H. Cancel COD order';
  const sH = await stockOf(storeId, p1.id);
  const h = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'COD', items: [{ productId: p1.id, quantity: qty(p1) }] });
  const H = h.body.data.order;
  await call('PUT', `/admin/orders/${H.id}/status`, managerToken, { status: 'CONFIRMED' });
  check('cancel', (await call('PUT', `/admin/orders/${H.id}/status`, managerToken, { status: 'CANCELLED' })).status === 200);
  const hRow = await orderRow(H.id);
  check('cancelled, payment stays PENDING (not charged), no refund', hRow.order_status === 'CANCELLED' && hRow.payment_status === 'PENDING' && (await db.query('select count(*) from refunds where order_id=$1', [H.id])).rows[0].count === '0', hRow.payment_status);
  check('stock put back', (await stockOf(storeId, p1.id)) === sH);
  const again2 = await call('PUT', `/admin/orders/${H.id}/status`, managerToken, { status: 'CANCELLED' });
  check('repeating cancel is a no-op (stock not added twice)', again2.status === 200 && (await stockOf(storeId, p1.id)) === sH);

  // ---------- I. Rules and safety ----------
  scenario = 'I. Rules';
  const dup = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', items: [{ productId: p2.id, quantity: 1 }, { productId: p2.id, quantity: 1 }] });
  check('same product twice refused', dup.body.errorCode === 'DUPLICATE_ORDER_ITEM', dup.body);
  const small = await placeOrder({ fulfillmentType: 'DELIVERY', addressId, paymentMethod: 'COD', items: [{ productId: p2.id, quantity: 1 }] });
  check('delivery below ₹199 minimum refused', Number(p2.price) >= 199 || small.body.errorCode === 'MINIMUM_DELIVERY_AMOUNT_NOT_MET', small.body);
  const priced = await placeOrder({ fulfillmentType: 'PICKUP', storeId, paymentMethod: 'COD', total: 1, items: [{ productId: p2.id, quantity: 1, price: 1 }] });
  check('app-sent price ignored', priced.status === 201 && priced.body.data.order.total === Number(p2.price), priced.body.data?.order);
  await call('PUT', `/admin/orders/${priced.body.data.order.id}/status`, managerToken, { status: 'CANCELLED' });
  const other = await call('GET', `/payments/orders/${A.id}/status`, managerToken);
  check('staff cannot use customer payment endpoints', other.status === 403, other.status);
  const forged = await fetch(`${API}/payments/webhook/cashfree`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-timestamp': String(Date.now()), 'x-webhook-signature': 'forged' },
    body: JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: G.id } } }),
  });
  check('forged webhook rejected', forged.status === 401, forged.status);

  // ---------- Summary ----------
  const failedChecks = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
  if (failedChecks.length) console.log(JSON.stringify(failedChecks, null, 2));
  await db.end();
}

main().catch(async (e) => {
  console.error('E2E aborted:', e);
  await db.end();
  process.exit(1);
});
