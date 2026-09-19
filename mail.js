'use strict';

const nodemailer = require('nodemailer');
const T = require('./time');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const euros = (cents) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

function itemsTable(items) {
  const rows = items
    .map(
      (i) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #e8e4da">
          <strong>${esc(i.product_name)}</strong> · ${esc(i.size_label)}
          ${i.dedication ? `<br><span style="color:#6b675f">Dedicatoria: «${esc(i.dedication)}»</span>` : ''}
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #e8e4da;text-align:center">×${i.qty}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e8e4da;text-align:right">${euros(i.unit_cents * i.qty)}</td>
      </tr>`
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:15px">${rows}</table>`;
}

function layout(title, body) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#fffdf8;font-family:Arial,Helvetica,sans-serif;color:#282622">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px">
      <p style="font:700 30px Georgia,serif;margin:0 0 24px">amy<span style="color:#ef7083">·</span></p>
      <h1 style="font:700 24px Georgia,serif;margin:0 0 16px">${title}</h1>
      ${body}
      <p style="margin-top:32px;font-size:13px;color:#6b675f">Heladería Amy · Calle Pedro Navarro nº18, Melilla</p>
    </div></body></html>`;
}

function createMailer(config, log = console) {
  const enabled = Boolean(config.mail.host);
  const transport = enabled
    ? nodemailer.createTransport({
        host: config.mail.host,
        port: config.mail.port,
        secure: config.mail.port === 465,
        auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined
      })
    : null;

  async function send(message) {
    if (!enabled) return false;
    try {
      await transport.sendMail({ from: config.mail.from, ...message });
      return true;
    } catch (err) {
      log.error('[mail] No se pudo enviar el email:', err.message);
      return false;
    }
  }

  return {
    enabled,

    /** Pago confirmado: confirmación al cliente y aviso a la tienda. */
    async orderPaid({ order, items }) {
      const when = `${T.longDate(order.pickup_date)} a las ${order.pickup_time}`;
      const customer = layout(
        `¡Gracias, ${esc(order.customer_name.split(' ')[0])}! Tu encargo está confirmado`,
        `<p style="font-size:16px">Te esperamos para recoger tu pedido el <strong>${esc(when)}</strong> en Calle Pedro Navarro nº18, Melilla.</p>
         ${itemsTable(items)}
         <p style="font-size:17px;text-align:right"><strong>Total pagado: ${euros(order.total_cents)}</strong></p>
         ${order.notes ? `<p style="color:#6b675f">Tus observaciones: ${esc(order.notes)}</p>` : ''}
         <p>Si necesitas cambiar algo, llámanos al ${esc(config.shopPhone)} indicando el número de pedido <strong>#${order.id}</strong>.</p>`
      );
      await send({ to: order.email, subject: `Encargo #${order.id} confirmado · Heladería Amy`, html: customer });

      if (config.shopEmail) {
        const shop = layout(
          `Nuevo encargo #${order.id}`,
          `<p><strong>Recogida:</strong> ${esc(when)}</p>
           <p><strong>Cliente:</strong> ${esc(order.customer_name)} · ${esc(order.phone)} · ${esc(order.email)}</p>
           ${itemsTable(items)}
           <p style="text-align:right"><strong>Total: ${euros(order.total_cents)}</strong></p>
           ${order.notes ? `<p><strong>Observaciones:</strong> ${esc(order.notes)}</p>` : ''}`
        );
        await send({ to: config.shopEmail, subject: `Nuevo encargo #${order.id} · ${when}`, html: shop });
      }
    },

    /** El personal marca el pedido como preparado. */
    async orderReady({ order }) {
      const html = layout(
        'Tu encargo está listo',
        `<p style="font-size:16px">Ya puedes pasar a recogerlo por Calle Pedro Navarro nº18. Pedido <strong>#${order.id}</strong>.</p>`
      );
      await send({ to: order.email, subject: `Tu encargo #${order.id} está listo · Heladería Amy`, html });
    }
  };
}

module.exports = { createMailer };
