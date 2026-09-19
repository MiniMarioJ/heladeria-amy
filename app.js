'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { ApiError } = require('./errors');
const T = require('./time');
const auth = require('./auth');
const { getSettings, saveSettings } = require('./settings');
const products = require('./products');
const orders = require('./orders');

const { STATUS } = orders;

function createApp({ config, db, stripe, mailer, log = console, now = () => new Date(), limits = {} }) {
  // Límites de peticiones por IP y ventana de 15 min (configurables para las pruebas).
  const maxCheckout = limits.checkout ?? 20;
  const maxLogin = limits.login ?? 10;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          // En local (http) este directiva rompe Safari; en producción sí se aplica.
          upgradeInsecureRequests: config.isProd ? [] : null
        }
      }
    })
  );

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const limiter = (windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Demasiadas peticiones. Inténtalo de nuevo en unos minutos.' }
    });

  /* ------------------------------------------------------------------
   * Webhook de Stripe. Necesita el cuerpo SIN parsear (firma), así que va antes de express.json().
   * ---------------------------------------------------------------- */

  function orderForSession(session) {
    const id = Number(session.metadata?.order_id);
    const found = Number.isInteger(id) ? orders.getOrder(db, id) : null;
    if (!found || found.order.public_id !== session.metadata?.public_id) return null;
    if (found.order.stripe_session_id && found.order.stripe_session_id !== session.id) return null;
    return found;
  }

  function handleStripeEvent(event) {
    const session = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (session.payment_status !== 'paid') break; // pagos diferidos: se confirma con async_payment_succeeded
        const found = orderForSession(session);
        if (!found) {
          log.warn(`[stripe] Sesión ${session.id} sin pedido asociado.`);
          break;
        }
        if (session.amount_total !== found.order.total_cents || session.currency !== 'eur') {
          log.error(
            `[stripe] ALERTA: el importe de la sesión ${session.id} (${session.amount_total} ${session.currency}) ` +
              `no coincide con el pedido #${found.order.id} (${found.order.total_cents} eur). No se marca como pagado.`
          );
          break;
        }
        const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        const wasExpired = found.order.status === STATUS.EXPIRED;
        if (orders.markPaid(db, found.order.id, pi, now().getTime())) {
          if (wasExpired) log.warn(`[stripe] El pedido #${found.order.id} estaba caducado pero se ha pagado: se acepta.`);
          mailer.orderPaid(orders.getOrder(db, found.order.id)).catch((e) => log.error('[mail]', e.message));
        }
        break;
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const found = orderForSession(session);
        if (found) orders.markExpired(db, found.order.id);
        break;
      }
      default:
        break;
    }
  }

  app.post('/api/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!stripe || !config.stripeWebhookSecret) return res.status(503).send('Webhook no configurado');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
    } catch (err) {
      log.warn('[stripe] Firma de webhook no válida:', err.message);
      return res.status(400).send('Firma no válida');
    }
    try {
      handleStripeEvent(event);
      res.json({ received: true });
    } catch (err) {
      log.error('[stripe] Error procesando el evento', event.type, err);
      res.status(500).send('Error'); // Stripe reintentará
    }
  });

  app.use(express.json({ limit: '50kb' }));
  app.use('/api', limiter(60 * 1000, 120));

  /* ------------------------------------------------------------------
   * API pública
   * ---------------------------------------------------------------- */

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  app.get('/api/products', (req, res) => {
    res.json({ products: products.listPublic(db) });
  });

  app.get('/api/config', (req, res) => {
    const settings = getSettings(db);
    res.json({ ...orders.publicConfig(db, settings, now()), phone: config.shopPhone });
  });

  app.get('/api/availability', (req, res) => {
    const units = Math.min(Math.max(parseInt(req.query.units, 10) || 1, 1), 100);
    res.json(orders.availability(db, getSettings(db), String(req.query.date || ''), units, now()));
  });

  app.post(
    '/api/checkout',
    limiter(15 * 60 * 1000, maxCheckout),
    wrap(async (req, res) => {
      if (!stripe) {
        throw new ApiError(
          503,
          `Los pagos online no están disponibles ahora mismo. Llámanos al ${config.shopPhone} para hacer tu encargo.`
        );
      }
      const { order, items } = orders.createOrder(db, getSettings(db), req.body, now());

      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          locale: 'es',
          customer_email: order.email,
          client_reference_id: order.public_id,
          line_items: items.map((i) => ({
            quantity: i.qty,
            price_data: {
              currency: 'eur',
              unit_amount: i.unit_cents,
              product_data: {
                name: `${i.product_name} · ${i.size_label}`,
                ...(i.dedication ? { description: `Dedicatoria: ${i.dedication}` } : {})
              }
            }
          })),
          metadata: { order_id: String(order.id), public_id: order.public_id },
          payment_intent_data: {
            description: `Encargo Heladería Amy #${order.id}`,
            metadata: { order_id: String(order.id), public_id: order.public_id }
          },
          custom_text: {
            submit: {
              message: `Recogida en tienda: ${T.longDate(order.pickup_date)} a las ${order.pickup_time}. Calle Pedro Navarro nº18, Melilla.`
            }
          },
          expires_at: Math.floor(now().getTime() / 1000) + 31 * 60,
          success_url: `${config.baseUrl}/pedido.html?o=${order.public_id}`,
          cancel_url: `${config.baseUrl}/tienda.html?cancelado=1`
        });
        db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, order.id);
        res.json({ url: session.url });
      } catch (err) {
        orders.markExpired(db, order.id); // libera el aforo
        log.error(`[stripe] No se pudo crear la sesión de pago del pedido #${order.id}:`, err.message);
        throw new ApiError(502, 'No hemos podido iniciar el pago. Inténtalo de nuevo en unos minutos.');
      }
    })
  );

  app.get('/api/orders/:publicId', limiter(60 * 1000, 60), (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.publicId)) throw new ApiError(404, 'Pedido no encontrado.');
    const found = orders.getOrderByPublicId(db, req.params.publicId);
    if (!found) throw new ApiError(404, 'Pedido no encontrado.');
    res.set('Cache-Control', 'no-store');
    res.json({ order: orders.publicOrder(found) });
  });

  /* ------------------------------------------------------------------
   * API de administración
   * ---------------------------------------------------------------- */

  const adminApi = express.Router();

  adminApi.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Defensa extra contra CSRF (además de la cookie SameSite=Strict): el origen debe ser este mismo sitio.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let host = '';
      try {
        host = new URL(req.headers.origin).host;
      } catch {
        /* origen ilegible */
      }
      if (host !== req.headers.host) return next(new ApiError(403, 'Origen no permitido.'));
    }
    next();
  });

  const requireAdmin = (req, res, next) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (!config.adminPassword || !auth.verifyToken(config.sessionSecret, token, now().getTime())) {
      return next(new ApiError(401, 'Sesión no iniciada.'));
    }
    next();
  };

  adminApi.post('/login', limiter(15 * 60 * 1000, maxLogin), (req, res) => {
    if (!config.adminPassword) {
      throw new ApiError(503, 'El panel no está activado: define ADMIN_PASSWORD en el archivo .env.');
    }
    if (!auth.passwordMatches(config.adminPassword, req.body?.password)) {
      throw new ApiError(401, 'Contraseña incorrecta.');
    }
    res.set(
      'Set-Cookie',
      auth.cookieHeader(auth.createToken(config.sessionSecret, now().getTime()), {
        secure: config.isProd,
        maxAgeSeconds: auth.SESSION_HOURS * 3600
      })
    );
    res.json({ ok: true });
  });

  adminApi.post('/logout', (req, res) => {
    res.set('Set-Cookie', auth.cookieHeader('', { secure: config.isProd, maxAgeSeconds: 0 }));
    res.json({ ok: true });
  });

  adminApi.get('/me', requireAdmin, (req, res) => {
    const sample = db.prepare('SELECT COUNT(*) AS n FROM products WHERE sample = 1').get().n;
    res.json({
      ok: true,
      system: {
        stripe: Boolean(stripe),
        stripeTestMode: config.stripeSecretKey.startsWith('sk_test_'),
        webhook: Boolean(config.stripeWebhookSecret),
        email: mailer.enabled,
        shopEmail: Boolean(config.shopEmail)
      },
      sampleProducts: sample
    });
  });

  adminApi.get('/orders', requireAdmin, (req, res) => {
    const list = orders.listOrders(
      db,
      { scope: req.query.scope === 'all' ? 'all' : 'upcoming', includeUnpaid: req.query.unpaid === '1' },
      now()
    );
    res.json({ orders: list.map(orders.adminOrder) });
  });

  adminApi.patch('/orders/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(404, 'Pedido no encontrado.');
    const status = req.body?.status;
    const { previous } = orders.setStatus(db, id, status);
    const found = orders.getOrder(db, id);
    if (status === STATUS.READY && previous !== STATUS.READY) {
      mailer.orderReady(found).catch((e) => log.error('[mail]', e.message));
    }
    res.json({ order: orders.adminOrder(found) });
  });

  adminApi.get('/products', requireAdmin, (req, res) => res.json({ products: products.listAll(db) }));
  adminApi.post('/products', requireAdmin, (req, res) => res.status(201).json({ product: products.create(db, req.body) }));
  adminApi.put('/products/:id', requireAdmin, (req, res) => {
    res.json({ product: products.update(db, Number(req.params.id), req.body) });
  });
  adminApi.delete('/products/:id', requireAdmin, (req, res) => {
    products.remove(db, Number(req.params.id));
    res.json({ ok: true });
  });

  adminApi.get('/settings', requireAdmin, (req, res) => res.json({ settings: getSettings(db) }));
  adminApi.put('/settings', requireAdmin, (req, res) => res.json({ settings: saveSettings(db, req.body) }));

  app.use('/api/admin', adminApi);
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

  /* ------------------------------------------------------------------
   * Archivos estáticos (la web)
   * ---------------------------------------------------------------- */

  app.use('/admin', (req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      extensions: ['html'],
      maxAge: config.isProd ? '1h' : 0
    })
  );

  /* ------------------------------------------------------------------
   * Errores
   * ---------------------------------------------------------------- */

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, field: err.field });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Los datos enviados no son válidos.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La petición es demasiado grande.' });
    log.error(err);
    res.status(500).json({ error: 'Ha ocurrido un error inesperado. Inténtalo de nuevo.' });
  });

  return app;
}

module.exports = { createApp };
