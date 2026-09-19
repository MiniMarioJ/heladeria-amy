'use strict';

/**
 * Pruebas del flujo completo: catálogo → encargo → Stripe (simulado) → webhook firmado → panel.
 * Ejecutar con: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');

const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const T = require('../src/time');

const WEBHOOK_SECRET = 'whsec_test_secret';
const ADMIN_PASSWORD = 'contraseña-de-prueba-123';

// Stripe "real" solo para firmar/verificar webhooks; la creación de sesiones se simula (no hay red).
const realStripe = new Stripe('sk_test_dummy');
const sessionsCreated = [];
const fakeStripe = {
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      create: async (args) => {
        const session = { id: `cs_test_${sessionsCreated.length + 1}`, url: 'https://checkout.stripe.com/c/pay/test' };
        sessionsCreated.push({ args, session });
        return session;
      }
    }
  }
};

const mails = { paid: [], ready: [] };
const fakeMailer = {
  enabled: true,
  orderPaid: async (o) => mails.paid.push(o),
  orderReady: async (o) => mails.ready.push(o)
};

const quietLog = { error() {}, warn() {}, log() {} };

let server;
let base;
let db;
let cookie = '';

const day = (n) => T.addDays(T.madridNow().date, n);

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sin cuerpo JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

const adminApi = (path, opts = {}) => api(path, { ...opts, headers: { cookie, ...(opts.headers || {}) } });

function validOrder(overrides = {}) {
  return {
    items: [{ productId: 1, sizeId: 's2', qty: 1, dedication: 'Feliz cumple, Ana' }],
    pickupDate: day(10),
    pickupTime: '17:00',
    name: 'Ana García',
    phone: '600 123 456',
    email: 'ana@example.com',
    notes: 'Sin frutos secos, por favor',
    acceptTerms: true,
    ...overrides
  };
}

function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return fetch(base + '/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload
  });
}

const completedEvent = (order, sessionId, extra = {}) => ({
  id: 'evt_' + Math.random().toString(36).slice(2),
  type: 'checkout.session.completed',
  data: {
    object: {
      id: sessionId,
      payment_status: 'paid',
      amount_total: order.total,
      currency: 'eur',
      payment_intent: 'pi_test_123',
      metadata: { order_id: String(order.id), public_id: order.publicId },
      ...extra
    }
  }
});

function orderRow(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

test.before(async () => {
  const config = loadConfig({
    ADMIN_PASSWORD,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SESSION_SECRET: 'x'.repeat(48),
    SHOP_EMAIL: 'tienda@example.com',
    BASE_URL: 'http://localhost:3000'
  });
  db = openDb(':memory:');
  const app = createApp({ config, db, stripe: fakeStripe, mailer: fakeMailer, log: quietLog, limits: { checkout: 1000, login: 1000 } });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
});

/* ------------------------------------------------------------------ */

test('sirve la web y aplica cabeceras de seguridad', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Heladería Amy/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/); // solo en producción
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('catálogo público: solo productos activos y sin datos internos', async () => {
  const { status, json } = await api('/api/products');
  assert.equal(status, 200);
  assert.equal(json.products.length, 5);
  const p = json.products[0];
  assert.equal(p.name, 'Tarta de Kinder');
  assert.equal(p.sizes[0].priceCents, 2800);
  assert.equal('sample' in p, false);
  assert.equal('active' in p, false);
});

test('config pública y disponibilidad', async () => {
  const { json: cfg } = await api('/api/config');
  assert.equal(cfg.leadHours, 48);
  assert.ok(cfg.minDate >= day(2) && cfg.minDate <= day(3));
  assert.equal(cfg.maxDate, day(60));

  const ok = await api(`/api/availability?date=${day(10)}&units=1`);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.slots.includes('11:00') && ok.json.slots.includes('21:00'));

  const past = await api(`/api/availability?date=${day(-1)}`);
  assert.equal(past.json.ok, false);

  const tooSoon = await api(`/api/availability?date=${day(0)}`);
  assert.equal(tooSoon.json.ok, false);
  assert.match(tooSoon.json.reason, /antelación/);

  const tooFar = await api(`/api/availability?date=${day(200)}`);
  assert.equal(tooFar.json.ok, false);

  const garbage = await api('/api/availability?date=hola');
  assert.equal(garbage.json.ok, false);
});

test('rechaza pedidos inválidos con mensajes claros', async () => {
  const cases = [
    [{ items: [] }, /al menos una tarta/],
    [{ name: 'A' }, /nombre/],
    [{ phone: '123' }, /teléfono/],
    [{ email: 'no-es-un-email' }, /email/],
    [{ acceptTerms: false }, /aceptar/],
    [{ pickupDate: day(0) }, /antelación/],
    [{ pickupDate: '2026-02-30' }, /fecha/],
    [{ pickupTime: '03:00' }, /hora/],
    [{ pickupTime: '17:10' }, /hora/],
    [{ items: [{ productId: 999, sizeId: 's1', qty: 1 }] }, /ya no está disponible/],
    [{ items: [{ productId: 1, sizeId: 's9', qty: 1 }] }, /ya no está disponible/],
    [{ items: [{ productId: 1, sizeId: 's1', qty: 0 }] }, /cantidad/],
    [{ items: [{ productId: 1, sizeId: 's1', qty: 99 }] }, /cantidad/],
    [{ items: [{ productId: 1, sizeId: 's1', qty: 1, dedication: 'x'.repeat(61) }] }, /dedicatoria/],
    [{ notes: 'x'.repeat(301) }, /observaciones/]
  ];
  for (const [override, pattern] of cases) {
    const r = await api('/api/checkout', { method: 'POST', body: validOrder(override) });
    assert.equal(r.status >= 400 && r.status < 500, true, JSON.stringify(override));
    assert.match(r.json.error, pattern, JSON.stringify(override));
  }
  assert.equal(sessionsCreated.length, 0, 'no se debe llamar a Stripe con datos inválidos');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0, 'no se debe guardar ningún pedido inválido');
});

let order; // pedido principal de la prueba

test('checkout: crea el pedido pendiente y la sesión de Stripe con precios del servidor', async () => {
  const body = validOrder();
  // Un cliente malicioso intenta abaratar el precio: el servidor debe ignorarlo.
  body.items[0].priceCents = 1;
  body.items[0].unitCents = 1;
  body.total = 1;

  const r = await api('/api/checkout', { method: 'POST', body });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.com\//);

  const { args } = sessionsCreated.at(-1);
  assert.equal(args.mode, 'payment');
  assert.equal(args.locale, 'es');
  assert.equal(args.customer_email, 'ana@example.com');
  assert.equal(args.line_items[0].price_data.unit_amount, 4000); // 12 raciones, precio de la BD
  assert.equal(args.line_items[0].price_data.currency, 'eur');
  assert.match(args.line_items[0].price_data.product_data.name, /Kinder · 12 raciones/);
  assert.match(args.line_items[0].price_data.product_data.description, /Feliz cumple, Ana/);
  assert.match(args.success_url, /^http:\/\/localhost:3000\/pedido\.html\?o=[a-f0-9]{24}$/);
  assert.match(args.custom_text.submit.message, /17:00/);

  const row = db.prepare("SELECT * FROM orders WHERE status = 'pendiente_pago'").get();
  assert.ok(row);
  assert.equal(row.total_cents, 4000);
  assert.equal(row.stripe_session_id, 'cs_test_1');
  order = { id: row.id, publicId: row.public_id, total: row.total_cents };
});

test('un pedido sin pagar no se marca como pagado sin webhook, y no aparece en el panel', async () => {
  const r = await api(`/api/orders/${order.publicId}`);
  assert.equal(r.json.order.status, 'pendiente_pago');
  assert.equal(r.json.order.firstName, 'Ana');
  assert.equal('phone' in r.json.order, false);
  assert.equal('email' in r.json.order, false);
});

test('webhook: rechaza firmas falsas y cuerpos manipulados', async () => {
  const payload = JSON.stringify(completedEvent(order, 'cs_test_1'));

  const noSig = await fetch(base + '/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload
  });
  assert.equal(noSig.status, 400);

  const badSig = await fetch(base + '/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_otro' })
    },
    body: payload
  });
  assert.equal(badSig.status, 400);

  // Firma válida de otro cuerpo, con el cuerpo cambiado
  const goodHeader = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const tampered = await fetch(base + '/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': goodHeader },
    body: payload.replace('4000', '1')
  });
  assert.equal(tampered.status, 400);

  assert.equal(orderRow(order.id).status, 'pendiente_pago');
});

test('webhook: importe distinto al del pedido no marca como pagado', async () => {
  const res = await signedWebhook(completedEvent(order, 'cs_test_1', { amount_total: 100 }));
  assert.equal(res.status, 200);
  assert.equal(orderRow(order.id).status, 'pendiente_pago');
  assert.equal(mails.paid.length, 0);
});

test('webhook: sesión de otro pedido no marca como pagado', async () => {
  const res = await signedWebhook(completedEvent(order, 'cs_test_OTRA'));
  assert.equal(res.status, 200);
  assert.equal(orderRow(order.id).status, 'pendiente_pago');
});

test('webhook: pago confirmado marca el pedido, guarda el pago y envía emails una sola vez', async () => {
  const event = completedEvent(order, 'cs_test_1');
  assert.equal((await signedWebhook(event)).status, 200);
  const row = orderRow(order.id);
  assert.equal(row.status, 'pagado');
  assert.equal(row.stripe_payment_id, 'pi_test_123');
  assert.ok(row.paid_at);
  assert.equal(mails.paid.length, 1);

  // Stripe reintenta el mismo evento: no debe duplicar nada.
  assert.equal((await signedWebhook(event)).status, 200);
  assert.equal(mails.paid.length, 1);

  const r = await api(`/api/orders/${order.publicId}`);
  assert.equal(r.json.order.status, 'pagado');
  assert.equal(r.json.order.pickupTime, '17:00');
});

test('panel: exige sesión', async () => {
  for (const path of ['/api/admin/me', '/api/admin/orders', '/api/admin/products', '/api/admin/settings']) {
    assert.equal((await api(path)).status, 401, path);
  }
  const put = await api('/api/admin/products/1', { method: 'PUT', body: {} });
  assert.equal(put.status, 401);
  const patch = await api('/api/admin/orders/1', { method: 'PATCH', body: { status: 'recogido' } });
  assert.equal(patch.status, 401);
  // Una cookie falsificada tampoco vale
  const forged = await api('/api/admin/me', { headers: { cookie: 'amy_admin=eyJleHAiOjk5OTk5OTk5OTk5OTl9.firmafalsa' } });
  assert.equal(forged.status, 401);
});

test('panel: login correcto e incorrecto', async () => {
  const bad = await api('/api/admin/login', { method: 'POST', body: { password: 'incorrecta' } });
  assert.equal(bad.status, 401);

  const good = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];

  const me = await adminApi('/api/admin/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.system.stripe, true);
  assert.equal(me.json.system.stripeTestMode, true);
  assert.equal(me.json.sampleProducts, 5);
});

test('panel: rechaza peticiones desde otro origen (CSRF)', async () => {
  const r = await adminApi('/api/admin/orders/1', {
    method: 'PATCH',
    body: { status: 'recogido' },
    headers: { origin: 'https://sitio-malicioso.example' }
  });
  assert.equal(r.status, 403);
});

test('panel: lista pedidos pagados con datos de contacto y cambia su estado', async () => {
  const list = await adminApi('/api/admin/orders');
  assert.equal(list.status, 200);
  assert.equal(list.json.orders.length, 1);
  const o = list.json.orders[0];
  assert.equal(o.name, 'Ana García');
  assert.equal(o.phone, '600 123 456');
  assert.equal(o.items[0].dedication, 'Feliz cumple, Ana');

  const ready = await adminApi(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status: 'preparado' } });
  assert.equal(ready.status, 200);
  assert.equal(ready.json.order.status, 'preparado');
  assert.equal(mails.ready.length, 1);

  // Marcar otra vez como preparado no reenvía el email
  await adminApi(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status: 'preparado' } });
  assert.equal(mails.ready.length, 1);

  const bad = await adminApi(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status: 'pendiente_pago' } });
  assert.equal(bad.status, 400);

  const picked = await adminApi(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status: 'recogido' } });
  assert.equal(picked.json.order.status, 'recogido');
});

test('panel: un pedido sin pagar no se puede gestionar', async () => {
  const r = await api('/api/checkout', {
    method: 'POST',
    body: validOrder({ pickupDate: day(11), email: 'sinpagar@example.com' })
  });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT id FROM orders WHERE email = 'sinpagar@example.com'").get();

  const hidden = await adminApi('/api/admin/orders');
  assert.equal(hidden.json.orders.some((o) => o.id === row.id), false);
  const shown = await adminApi('/api/admin/orders?unpaid=1');
  assert.equal(shown.json.orders.some((o) => o.id === row.id), true);

  const patch = await adminApi(`/api/admin/orders/${row.id}`, { method: 'PATCH', body: { status: 'recogido' } });
  assert.equal(patch.status, 409);
});

test('webhook: sesión caducada libera el pedido; un pago tardío se acepta igualmente', async () => {
  const row = db.prepare("SELECT * FROM orders WHERE email = 'sinpagar@example.com'").get();
  const o = { id: row.id, publicId: row.public_id, total: row.total_cents };
  const sessionId = row.stripe_session_id;

  const expired = { id: 'evt_exp', type: 'checkout.session.expired', data: { object: { id: sessionId, metadata: { order_id: String(o.id), public_id: o.publicId } } } };
  assert.equal((await signedWebhook(expired)).status, 200);
  assert.equal(orderRow(o.id).status, 'expirado');

  assert.equal((await signedWebhook(completedEvent(o, sessionId))).status, 200);
  assert.equal(orderRow(o.id).status, 'pagado');
});

test('aforo: no se pueden reservar más tartas que el máximo diario', async () => {
  const date = day(20);
  const put = await adminApi('/api/admin/settings', {
    method: 'PUT',
    body: { leadHours: 48, maxDaysAhead: 60, slotStart: '11:00', slotEnd: '21:00', slotMinutes: 30, closedWeekdays: [], blockedDates: [], maxUnitsPerDay: 3 }
  });
  assert.equal(put.status, 200);

  const two = await api('/api/checkout', {
    method: 'POST',
    body: validOrder({ pickupDate: date, items: [{ productId: 2, sizeId: 's1', qty: 2 }] })
  });
  assert.equal(two.status, 200);

  const avail = await api(`/api/availability?date=${date}&units=2`);
  assert.equal(avail.json.ok, false);
  assert.match(avail.json.reason, /solo queda 1 tarta/);
  assert.equal(avail.json.remaining, 1);

  const tooMany = await api('/api/checkout', {
    method: 'POST',
    body: validOrder({ pickupDate: date, items: [{ productId: 2, sizeId: 's1', qty: 2 }] })
  });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.json.error, /solo quedan 1/);

  const last = await api('/api/checkout', {
    method: 'POST',
    body: validOrder({ pickupDate: date, items: [{ productId: 3, sizeId: 's1', qty: 1 }] })
  });
  assert.equal(last.status, 200);

  const cfg = await api('/api/config');
  assert.ok(cfg.json.fullDates.includes(date));

  // Los pedidos sin pagar caducan del aforo tras 35 min: simulamos que llevan 2 h abiertos.
  db.prepare("UPDATE orders SET created_at = created_at - 7200000 WHERE status = 'pendiente_pago'").run();
  const freed = await api(`/api/availability?date=${date}&units=3`);
  assert.equal(freed.json.ok, true);
});

test('ajustes: días de cierre y fechas bloqueadas se respetan', async () => {
  const closedDate = day(30);
  const blocked = day(31);
  const put = await adminApi('/api/admin/settings', {
    method: 'PUT',
    body: {
      leadHours: 24, maxDaysAhead: 90, slotStart: '12:00', slotEnd: '20:00', slotMinutes: 60,
      closedWeekdays: [T.weekday(closedDate)], blockedDates: [blocked], maxUnitsPerDay: 0
    }
  });
  assert.equal(put.status, 200);

  assert.match((await api(`/api/availability?date=${closedDate}`)).json.reason, /cerrada/);
  assert.match((await api(`/api/availability?date=${blocked}`)).json.reason, /No aceptamos/);

  const slots = (await api(`/api/availability?date=${day(40)}`)).json.slots;
  assert.deepEqual(slots.slice(0, 2), ['12:00', '13:00']);
  assert.equal(slots.at(-1), '20:00');

  const r = await api('/api/checkout', { method: 'POST', body: validOrder({ pickupDate: closedDate }) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cerrada/);

  const invalid = await adminApi('/api/admin/settings', {
    method: 'PUT',
    body: { leadHours: 24, maxDaysAhead: 90, slotStart: '20:00', slotEnd: '12:00', slotMinutes: 60, closedWeekdays: [], blockedDates: [], maxUnitsPerDay: 0 }
  });
  assert.equal(invalid.status, 400);
  const allClosed = await adminApi('/api/admin/settings', {
    method: 'PUT',
    body: { leadHours: 24, maxDaysAhead: 90, slotStart: '12:00', slotEnd: '20:00', slotMinutes: 60, closedWeekdays: [0, 1, 2, 3, 4, 5, 6], blockedDates: [], maxUnitsPerDay: 0 }
  });
  assert.equal(allClosed.status, 400);
});

test('panel: crear, editar, desactivar y borrar productos', async () => {
  const created = await adminApi('/api/admin/products', {
    method: 'POST',
    body: { name: 'Tarta de Menta', description: 'Fresca', color: '#b7e1d4', image: '', active: true, sort: 9, sizes: [{ label: '10 raciones', priceCents: 3500 }] }
  });
  assert.equal(created.status, 201);
  const id = created.json.product.id;
  assert.equal(created.json.product.sizes[0].id, 's1');

  assert.ok((await api('/api/products')).json.products.some((p) => p.id === id));

  const off = await adminApi(`/api/admin/products/${id}`, {
    method: 'PUT',
    body: { name: 'Tarta de Menta', description: 'Fresca', color: '#b7e1d4', image: 'assets/menta.jpg', active: false, sort: 9, sizes: [{ label: '10 raciones', priceCents: 3600 }] }
  });
  assert.equal(off.status, 200);
  assert.equal((await api('/api/products')).json.products.some((p) => p.id === id), false);

  // Un producto desactivado no se puede comprar
  const buy = await api('/api/checkout', { method: 'POST', body: validOrder({ items: [{ productId: id, sizeId: 's1', qty: 1 }] }) });
  assert.equal(buy.status, 409);

  // Validaciones
  const badImage = await adminApi(`/api/admin/products/${id}`, {
    method: 'PUT',
    body: { name: 'X y', description: '', color: '#b7e1d4', image: '../../etc/passwd', active: true, sort: 0, sizes: [{ label: 'a', priceCents: 1000 }] }
  });
  assert.equal(badImage.status, 400);
  const badPrice = await adminApi('/api/admin/products', {
    method: 'POST',
    body: { name: 'Gratis', description: '', color: '#b7e1d4', active: true, sizes: [{ label: 'a', priceCents: 0 }] }
  });
  assert.equal(badPrice.status, 400);

  // Editar un producto de ejemplo lo marca como revisado
  await adminApi('/api/admin/products/1', {
    method: 'PUT',
    body: { name: 'Tarta de Kinder', description: 'Chocolate y avellana.', color: '#f3ccb7', image: '', active: true, sort: 0, sizes: [{ label: '8 raciones', priceCents: 2900 }] }
  });
  assert.equal((await adminApi('/api/admin/me')).json.sampleProducts, 4);

  assert.equal((await adminApi(`/api/admin/products/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await adminApi(`/api/admin/products/${id}`, { method: 'DELETE' })).status, 404);
});

test('panel: cerrar sesión invalida la cookie del navegador', async () => {
  const out = await adminApi('/api/admin/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('pedidos públicos: identificadores inválidos o inexistentes devuelven 404', async () => {
  assert.equal((await api('/api/orders/1')).status, 404);
  assert.equal((await api('/api/orders/' + 'a'.repeat(24))).status, 404);
  assert.equal((await api('/api/orders/%27%20OR%201=1')).status, 404);
});

test('JSON malformado devuelve 400, no 500', async () => {
  const res = await fetch(base + '/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{esto no es json'
  });
  assert.equal(res.status, 400);
});

test('limitador: bloquea el exceso de intentos de checkout y de login', async () => {
  const config = loadConfig({ ADMIN_PASSWORD, STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const db2 = openDb(':memory:');
  const app2 = createApp({ config, db: db2, stripe: fakeStripe, mailer: fakeMailer, log: quietLog, limits: { checkout: 3, login: 3 } });
  const srv = await new Promise((resolve) => {
    const s = app2.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const post = (path, body) =>
      fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('/api/admin/login', { password: 'mala' })).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);

    const co = [];
    for (let i = 0; i < 5; i++) co.push((await post('/api/checkout', {})).status);
    assert.deepEqual(co, [400, 400, 400, 429, 429]);
  } finally {
    srv.close();
    db2.close();
  }
});
