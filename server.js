'use strict';

const Stripe = require('stripe');
const { loadConfig, configProblems } = require('./src/config');
const { openDb } = require('./src/db');
const { createMailer } = require('./src/mail');
const { createApp } = require('./src/app');
const orders = require('./src/orders');

const config = loadConfig();
const { errors, warnings } = configProblems(config);

if (errors.length) {
  console.error('\nNo se puede arrancar por estos motivos:');
  errors.forEach((e) => console.error('  ✗ ' + e));
  process.exit(1);
}
warnings.forEach((w) => console.warn('⚠ ' + w));

const db = openDb(config.dbPath);
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
const mailer = createMailer(config);
const app = createApp({ config, db, stripe, mailer });

const server = app.listen(config.port, () => {
  console.log(`\nHeladería Amy funcionando en ${config.baseUrl}`);
  console.log(`  Web:    ${config.baseUrl}/`);
  console.log(`  Tienda: ${config.baseUrl}/tienda.html`);
  console.log(`  Panel:  ${config.baseUrl}/admin.html\n`);
});

// Los pedidos que se quedan sin pagar más de 1 hora se marcan como caducados.
const cleanup = setInterval(() => {
  try {
    const n = orders.expireStale(db, 60 * 60 * 1000);
    if (n) console.log(`[limpieza] ${n} pedido(s) sin pagar marcados como caducados.`);
  } catch (err) {
    console.error('[limpieza]', err);
  }
}, 10 * 60 * 1000);
cleanup.unref();

function shutdown() {
  clearInterval(cleanup);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
