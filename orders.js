'use strict';

const crypto = require('crypto');
const { ApiError } = require('./errors');
const T = require('./time');

const STATUS = {
  PENDING: 'pendiente_pago',
  PAID: 'pagado',
  READY: 'preparado',
  PICKED: 'recogido',
  CANCELLED: 'cancelado',
  EXPIRED: 'expirado'
};

// Estados sobre los que puede actuar el personal desde el panel.
const MANAGEABLE = [STATUS.PAID, STATUS.READY, STATUS.PICKED, STATUS.CANCELLED];

// Un pedido sin pagar reserva sitio en el aforo del día durante este tiempo
// (algo más que los 30 min que dura la sesión de pago de Stripe).
const HOLD_MS = 35 * 60 * 1000;

const MAX_QTY_PER_LINE = 10;
const MAX_LINES = 20;

/* ---------- Validación de texto ---------- */

function text(value, { field, label, min = 0, max }) {
  const v = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length < min) throw new ApiError(400, `Escribe ${label}.`, field);
  if (v.length > max) throw new ApiError(400, `Máximo ${max} caracteres en ${label}.`, field);
  return v;
}

function validPhone(value) {
  const v = text(value, { field: 'phone', label: 'tu teléfono', min: 1, max: 30 });
  const digits = v.replace(/\D/g, '');
  if (!/^[+\d][\d\s().-]*$/.test(v) || digits.length < 9 || digits.length > 15) {
    throw new ApiError(400, 'Escribe un teléfono válido, por ejemplo 951 005 306.', 'phone');
  }
  return v;
}

function validEmail(value) {
  const v = text(value, { field: 'email', label: 'tu email', min: 1, max: 120 });
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
    throw new ApiError(400, 'Escribe un email válido, por ejemplo nombre@correo.com.', 'email');
  }
  return v;
}

/* ---------- Disponibilidad ---------- */

function leadText(hours) {
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} días` : `${hours} horas`;
}

const COUNTS_SQL = `
  (o.status IN ('${STATUS.PAID}', '${STATUS.READY}', '${STATUS.PICKED}')
   OR (o.status = '${STATUS.PENDING}' AND o.created_at > @since))`;

function unitsBooked(db, dateISO, nowMs) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty), 0) AS n
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.pickup_date = @date AND ${COUNTS_SQL}`
    )
    .get({ date: dateISO, since: nowMs - HOLD_MS }).n;
}

/** Fechas (desde `fromISO`) que ya han alcanzado el máximo de tartas por día. */
function fullDates(db, settings, fromISO, nowMs) {
  if (!settings.maxUnitsPerDay) return [];
  return db
    .prepare(
      `SELECT o.pickup_date AS d, SUM(oi.qty) AS n
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.pickup_date >= @from AND ${COUNTS_SQL}
       GROUP BY o.pickup_date HAVING n >= @max`
    )
    .all({ from: fromISO, since: nowMs - HOLD_MS, max: settings.maxUnitsPerDay })
    .map((r) => r.d);
}

function dayProblem(settings, dateISO, now) {
  if (!T.isValidISODate(dateISO)) return 'Elige una fecha de recogida válida.';
  if (dateISO < now.date) return 'Esa fecha ya ha pasado.';
  if (dateISO > T.addDays(now.date, settings.maxDaysAhead)) {
    return `Solo se puede encargar con un máximo de ${settings.maxDaysAhead} días de antelación.`;
  }
  if (settings.closedWeekdays.includes(T.weekday(dateISO))) return 'Ese día la heladería está cerrada.';
  if (settings.blockedDates.includes(dateISO)) return 'No aceptamos encargos para ese día.';
  return null;
}

function slotsFor(settings, dateISO, now) {
  const minWall = now.wall + settings.leadHours * 3600 * 1000;
  return T.buildSlots(settings.slotStart, settings.slotEnd, settings.slotMinutes).filter(
    (t) => T.wallMs(dateISO, t) >= minWall
  );
}

function availability(db, settings, dateISO, units, nowDate = new Date()) {
  const now = T.madridNow(nowDate);
  const problem = dayProblem(settings, dateISO, now);
  if (problem) return { ok: false, reason: problem, slots: [], remaining: null };

  const slots = slotsFor(settings, dateISO, now);
  if (slots.length === 0) {
    return {
      ok: false,
      reason: `Los encargos necesitan al menos ${leadText(settings.leadHours)} de antelación.`,
      slots: [],
      remaining: null
    };
  }

  let remaining = null;
  if (settings.maxUnitsPerDay > 0) {
    remaining = Math.max(0, settings.maxUnitsPerDay - unitsBooked(db, dateISO, nowDate.getTime()));
    if (remaining < units) {
      const reason =
        remaining === 0
          ? 'Ya no quedan tartas disponibles para ese día.'
          : remaining === 1
            ? 'Para ese día solo queda 1 tarta disponible.'
            : `Para ese día solo quedan ${remaining} tartas disponibles.`;
      return { ok: false, reason, slots: [], remaining };
    }
  }
  return { ok: true, slots, remaining };
}

/** Datos públicos que necesita el formulario de encargo. */
function publicConfig(db, settings, nowDate = new Date()) {
  const now = T.madridNow(nowDate);
  const earliest = new Date(now.wall + settings.leadHours * 3600 * 1000).toISOString().slice(0, 10);
  return {
    leadHours: settings.leadHours,
    leadText: leadText(settings.leadHours),
    minDate: earliest,
    maxDate: T.addDays(now.date, settings.maxDaysAhead),
    closedWeekdays: settings.closedWeekdays,
    blockedDates: settings.blockedDates.filter((d) => d >= now.date),
    fullDates: fullDates(db, settings, now.date, nowDate.getTime()),
    maxQtyPerLine: MAX_QTY_PER_LINE
  };
}

/* ---------- Creación de pedidos ---------- */

function createOrder(db, settings, input, nowDate = new Date()) {
  if (!input || typeof input !== 'object') throw new ApiError(400, 'Datos no válidos.');
  const now = T.madridNow(nowDate);

  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(400, 'Añade al menos una tarta a tu pedido.', 'items');
  }
  if (rawItems.length > MAX_LINES) {
    throw new ApiError(400, `Un pedido admite como máximo ${MAX_LINES} líneas.`, 'items');
  }

  const name = text(input.name, { field: 'name', label: 'tu nombre', min: 2, max: 80 });
  const phone = validPhone(input.phone);
  const email = validEmail(input.email);
  const notes = text(input.notes, { field: 'notes', label: 'las observaciones', max: 300 });
  if (input.acceptTerms !== true) {
    throw new ApiError(400, 'Debes aceptar las condiciones del encargo y la política de privacidad.', 'acceptTerms');
  }

  // Fecha y hora de recogida
  const pickupDate = input.pickupDate;
  const pickupTime = input.pickupTime;
  const dp = dayProblem(settings, pickupDate, now);
  if (dp) throw new ApiError(400, dp, 'pickupDate');
  if (!T.isValidTime(pickupTime) || !T.buildSlots(settings.slotStart, settings.slotEnd, settings.slotMinutes).includes(pickupTime)) {
    throw new ApiError(400, 'Elige una hora de recogida válida.', 'pickupTime');
  }
  if (!slotsFor(settings, pickupDate, now).includes(pickupTime)) {
    throw new ApiError(400, `Los encargos necesitan al menos ${leadText(settings.leadHours)} de antelación.`, 'pickupTime');
  }

  // Líneas del pedido: el precio SIEMPRE sale de la base de datos, nunca del navegador.
  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const items = rawItems.map((raw) => {
    const product = getProduct.get(Number(raw?.productId));
    const size = product ? JSON.parse(product.sizes).find((s) => s.id === raw?.sizeId) : null;
    if (!product || !size) {
      throw new ApiError(409, 'Alguno de los productos ya no está disponible. Revisa tu pedido.', 'items');
    }
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new ApiError(400, `La cantidad debe estar entre 1 y ${MAX_QTY_PER_LINE}.`, 'items');
    }
    return {
      product_id: product.id,
      product_name: product.name,
      size_label: size.label,
      unit_cents: size.price_cents,
      qty,
      dedication: text(raw.dedication, { field: 'items', label: 'la dedicatoria', max: 60 })
    };
  });

  const totalUnits = items.reduce((n, i) => n + i.qty, 0);
  const totalCents = items.reduce((n, i) => n + i.qty * i.unit_cents, 0);

  const insertOrder = db.prepare(
    `INSERT INTO orders (public_id, customer_name, phone, email, pickup_date, pickup_time, notes,
                         total_cents, status, created_at)
     VALUES (@public_id, @name, @phone, @email, @pickupDate, @pickupTime, @notes, @total, '${STATUS.PENDING}', @created)`
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, size_label, unit_cents, qty, dedication)
     VALUES (@order_id, @product_id, @product_name, @size_label, @unit_cents, @qty, @dedication)`
  );

  // Comprobar aforo e insertar en la misma transacción evita que dos clientes reserven la última tarta a la vez.
  const orderId = db.transaction(() => {
    if (settings.maxUnitsPerDay > 0) {
      const remaining = settings.maxUnitsPerDay - unitsBooked(db, pickupDate, nowDate.getTime());
      if (totalUnits > remaining) {
        throw new ApiError(
          409,
          remaining <= 0
            ? 'Ya no quedan tartas disponibles para ese día. Elige otra fecha.'
            : `Para ese día solo quedan ${remaining} tartas disponibles.`,
          'pickupDate'
        );
      }
    }
    const info = insertOrder.run({
      public_id: crypto.randomBytes(12).toString('hex'),
      name,
      phone,
      email,
      pickupDate,
      pickupTime,
      notes,
      total: totalCents,
      created: nowDate.getTime()
    });
    const id = Number(info.lastInsertRowid);
    for (const item of items) insertItem.run({ order_id: id, ...item });
    return id;
  })();

  return getOrder(db, orderId);
}

/* ---------- Consultas ---------- */

function attachItems(db, orders) {
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);
  const rows = db
    .prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids);
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(row);
  }
  return orders.map((order) => ({ order, items: byOrder.get(order.id) || [] }));
}

function getOrder(db, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return order ? attachItems(db, [order])[0] : null;
}

function getOrderByPublicId(db, publicId) {
  const order = db.prepare('SELECT * FROM orders WHERE public_id = ?').get(publicId);
  return order ? attachItems(db, [order])[0] : null;
}

function listOrders(db, { scope, includeUnpaid }, nowDate = new Date()) {
  const where = [];
  const params = {};
  if (scope === 'upcoming') {
    where.push('pickup_date >= @today');
    params.today = T.madridNow(nowDate).date;
  }
  if (!includeUnpaid) {
    where.push(`status IN (${MANAGEABLE.map((s) => `'${s}'`).join(',')})`);
  }
  const dir = scope === 'upcoming' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(
      `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY pickup_date ${dir}, pickup_time ${dir}, id ${dir} LIMIT 500`
    )
    .all(params);
  return attachItems(db, rows);
}

/* ---------- Cambios de estado ---------- */

/** Marca un pedido como pagado. Devuelve true solo la primera vez (idempotente para los reintentos de Stripe). */
function markPaid(db, orderId, paymentIntentId, nowMs = Date.now()) {
  const info = db
    .prepare(
      `UPDATE orders SET status = '${STATUS.PAID}', paid_at = @paidAt,
              stripe_payment_id = COALESCE(@pi, stripe_payment_id)
       WHERE id = @id AND status IN ('${STATUS.PENDING}', '${STATUS.EXPIRED}')`
    )
    .run({ id: orderId, pi: paymentIntentId || null, paidAt: nowMs });
  return info.changes === 1;
}

function markExpired(db, orderId) {
  return (
    db
      .prepare(`UPDATE orders SET status = '${STATUS.EXPIRED}' WHERE id = ? AND status = '${STATUS.PENDING}'`)
      .run(orderId).changes === 1
  );
}

function expireStale(db, olderThanMs, nowMs = Date.now()) {
  return db
    .prepare(`UPDATE orders SET status = '${STATUS.EXPIRED}' WHERE status = '${STATUS.PENDING}' AND created_at < ?`)
    .run(nowMs - olderThanMs).changes;
}

function setStatus(db, orderId, status) {
  if (!MANAGEABLE.includes(status)) throw new ApiError(400, 'Estado no válido.');
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new ApiError(404, 'Pedido no encontrado.');
  if (!MANAGEABLE.includes(order.status)) {
    throw new ApiError(409, 'Este pedido no está pagado, así que no se puede cambiar su estado.');
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
  return { previous: order.status };
}

/* ---------- Serialización ---------- */

function publicOrder({ order, items }) {
  return {
    id: order.id,
    status: order.status,
    firstName: order.customer_name.split(' ')[0],
    pickupDate: order.pickup_date,
    pickupLabel: T.longDate(order.pickup_date),
    pickupTime: order.pickup_time,
    totalCents: order.total_cents,
    items: items.map((i) => ({
      name: i.product_name,
      size: i.size_label,
      qty: i.qty,
      dedication: i.dedication,
      unitCents: i.unit_cents
    }))
  };
}

function adminOrder({ order, items }) {
  return {
    ...publicOrder({ order, items }),
    name: order.customer_name,
    phone: order.phone,
    email: order.email,
    notes: order.notes,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    stripePaymentId: order.stripe_payment_id
  };
}

module.exports = {
  STATUS,
  MANAGEABLE,
  HOLD_MS,
  availability,
  publicConfig,
  createOrder,
  getOrder,
  getOrderByPublicId,
  listOrders,
  markPaid,
  markExpired,
  expireStale,
  setStatus,
  publicOrder,
  adminOrder
};
