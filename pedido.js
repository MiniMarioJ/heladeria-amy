(() => {
  'use strict';

  const page = document.querySelector('#page');
  const publicId = new URLSearchParams(location.search).get('o') || '';
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const money = (c) => eur.format(c / 100);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const PAID = ['pagado', 'preparado', 'recogido'];
  const POLL_MS = 2500;
  const MAX_POLLS = 16; // ~40 s esperando al webhook de Stripe
  let phone = '951 005 306';
  let polls = 0;

  const tel = () => `tel:+34${phone.replace(/\D/g, '')}`;

  function actions(extra = '') {
    return `<div class="page-actions">${extra}<a class="underlined" href="index.html">Volver a la web</a></div>`;
  }

  function receipt(o) {
    const items = o.items
      .map(
        (i) => `<li>
          <span><strong>${esc(i.name)}</strong> · ${esc(i.size)} ×${i.qty}
            ${i.dedication ? `<small>Dedicatoria: «${esc(i.dedication)}»</small>` : ''}</span>
          <span>${money(i.unitCents * i.qty)}</span>
        </li>`
      )
      .join('');
    return `<section class="receipt" aria-label="Resumen del encargo">
      <h2>Encargo #${o.id}</h2>
      <dl>
        <dt>Recogida</dt><dd>${esc(o.pickupLabel)} a las ${esc(o.pickupTime)}</dd>
        <dt>Dónde</dt><dd>Calle Pedro Navarro nº18, Melilla</dd>
      </dl>
      <ul>${items}</ul>
      <div class="sum"><span>Total pagado</span><span>${money(o.totalCents)}</span></div>
    </section>`;
  }

  function render(o) {
    document.title = `Encargo #${o.id} · Heladería Amy`;

    if (PAID.includes(o.status)) {
      try {
        localStorage.removeItem('amy_cart_v1'); // el pedido ya está pagado: vaciamos el carrito guardado
      } catch {
        /* sin almacenamiento */
      }
      const done = o.status === 'recogido';
      page.innerHTML = `
        <h1>${done ? 'Encargo<br><em>recogido.</em>' : `¡Gracias, ${esc(o.firstName)}!<br>Tu encargo está <em>confirmado.</em>`}</h1>
        <p class="lead">${
          done
            ? 'Este encargo ya se ha recogido. ¡Que lo disfrutéis!'
            : `Te esperamos el <strong>${esc(o.pickupLabel)}</strong> a las <strong>${esc(o.pickupTime)}</strong>. Si necesitas cambiar algo, llámanos al <a href="${tel()}">${esc(phone)}</a> indicando el número de pedido.`
        }</p>
        ${receipt(o)}
        ${actions('<a class="button dark" href="tienda.html">Hacer otro encargo <b>→</b></a>')}`;
      return;
    }

    if (o.status === 'pendiente_pago') {
      if (polls < MAX_POLLS) {
        page.innerHTML = `
          <h1>Confirmando<br>tu <em>pago…</em></h1>
          <p class="lead">Estamos esperando la confirmación de tu banco. No cierres esta página ni vuelvas a pagar: suele tardar unos segundos.</p>`;
      } else {
        page.innerHTML = `
          <h1>Todavía no vemos<br>el <em>pago.</em></h1>
          <p class="lead">A veces tarda unos minutos. Si tu banco ya te ha cobrado, <strong>no pagues de nuevo</strong>: llámanos al <a href="${tel()}">${esc(phone)}</a> con el número de pedido <strong>#${o.id}</strong> y lo comprobamos enseguida.</p>
          ${actions(`<a class="button dark" href="${esc(location.pathname + location.search)}">Comprobar de nuevo <b>↻</b></a>`)}`;
      }
      return;
    }

    if (o.status === 'cancelado') {
      page.innerHTML = `
        <h1>Encargo<br><em>cancelado.</em></h1>
        <p class="lead">Este encargo (#${o.id}) está cancelado. Si tienes dudas o crees que es un error, llámanos al <a href="${tel()}">${esc(phone)}</a>.</p>
        ${actions()}`;
      return;
    }

    page.innerHTML = `
      <h1>El pago no se<br>ha <em>completado.</em></h1>
      <p class="lead">No se ha cobrado nada. Puedes volver a la tienda y repetir tu encargo cuando quieras.</p>
      ${actions('<a class="button dark" href="tienda.html">Volver a la tienda <b>→</b></a>')}`;
  }

  function notFound() {
    document.title = 'Encargo no encontrado · Heladería Amy';
    page.innerHTML = `
      <h1>No encontramos<br>este <em>encargo.</em></h1>
      <p class="lead">Comprueba que has abierto el enlace completo. Si acabas de pagar, llámanos al <a href="${tel()}">${esc(phone)}</a> y lo revisamos.</p>
      ${actions('<a class="button dark" href="tienda.html">Ir a la tienda <b>→</b></a>')}`;
  }

  async function check() {
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(publicId)}`, { cache: 'no-store' });
      if (res.status === 404) return notFound();
      if (!res.ok) throw new Error('error');
      const { order } = await res.json();
      polls += order.status === 'pendiente_pago' ? 1 : 0;
      render(order);
      if (order.status === 'pendiente_pago' && polls < MAX_POLLS) setTimeout(check, POLL_MS);
    } catch {
      page.innerHTML = `<h1>Sin <em>conexión.</em></h1>
        <p class="lead">No hemos podido comprobar tu encargo. Recarga la página en unos segundos.</p>`;
    }
  }

  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      if (c?.phone) phone = c.phone;
    })
    .catch(() => {})
    .finally(() => (publicId ? check() : notFound()));
})();
