(() => {
  'use strict';

  const CART_KEY = 'amy_cart_v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const money = (cents) => eur.format(cents / 100);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ---------- Estado ---------- */

  const state = {
    products: [],
    config: null,
    cart: loadCart(),
    pick: null, // { product, sizeId, qty }
    date: '',
    time: '',
    contact: { name: '', phone: '', email: '', notes: '', accept: false },
    submitting: false
  };
  let bodyMode = ''; // 'empty' | 'form': evita redibujar el formulario y perder lo que el cliente ha escrito
  let availabilitySeq = 0;

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(raw)
        ? raw
            .filter((l) => l && Number.isInteger(l.productId) && typeof l.sizeId === 'string' && Number.isInteger(l.qty) && l.qty > 0)
            .map((l) => ({ productId: l.productId, sizeId: l.sizeId, qty: l.qty, dedication: String(l.dedication || '').slice(0, 60) }))
        : [];
    } catch {
      return [];
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    } catch {
      /* almacenamiento no disponible (modo privado): el pedido sigue funcionando en esta visita */
    }
  }

  /* ---------- Utilidades ---------- */

  const findProduct = (id) => state.products.find((p) => p.id === id);
  const findSize = (product, sizeId) => product?.sizes.find((s) => s.id === sizeId);
  const cartUnits = () => state.cart.reduce((n, l) => n + l.qty, 0);
  const maxQty = () => state.config?.maxQtyPerLine || 10;

  function lineInfo(line) {
    const product = findProduct(line.productId);
    const size = findSize(product, line.sizeId);
    return product && size ? { product, size } : null;
  }

  function cartTotal() {
    return state.cart.reduce((sum, l) => {
      const info = lineInfo(l);
      return info ? sum + info.size.priceCents * l.qty : sum;
    }, 0);
  }

  async function getJSON(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* sin cuerpo */
    }
    if (!res.ok) {
      const err = new Error(data?.error || 'Ha ocurrido un error. Inténtalo de nuevo.');
      err.field = data?.field;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showNotice(message) {
    const area = $('#notice-area');
    area.innerHTML = `<p class="notice" role="status"><span>${esc(message)}</span><button type="button" aria-label="Cerrar aviso">×</button></p>`;
    $('button', area).addEventListener('click', () => (area.innerHTML = ''));
  }

  /* ---------- Catálogo ---------- */

  function renderCatalog() {
    const grid = $('#catalog');
    const stateEl = $('#catalog-state');
    if (state.products.length === 0) {
      grid.innerHTML = '';
      stateEl.hidden = false;
      stateEl.innerHTML = `Ahora mismo no hay tartas disponibles para encargar online. Llámanos al <a href="tel:${telHref()}">${esc(state.config?.phone || '951 005 306')}</a> y te ayudamos.`;
      return;
    }
    stateEl.hidden = true;
    grid.innerHTML = state.products
      .map((p) => {
        const min = Math.min(...p.sizes.map((s) => s.priceCents));
        return `<article class="product" style="--tint:${esc(p.color)}">
          ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : ''}
          <div class="product-body">
            <h3>${esc(p.name)}</h3>
            <p>${esc(p.description)}</p>
            <div class="product-foot">
              <div class="product-price"><small>${p.sizes.length > 1 ? 'Desde' : '&nbsp;'}</small>${money(min)}</div>
              <button class="button dark" type="button" data-pick="${p.id}">Elegir <b>→</b></button>
            </div>
          </div>
        </article>`;
      })
      .join('');
  }

  function telHref() {
    const digits = String(state.config?.phone || '951005306').replace(/\D/g, '');
    return `+34${digits}`;
  }

  /* ---------- Diálogo: elegir tarta ---------- */

  const pickDialog = $('#pick-dialog');

  function openPick(productId) {
    const product = findProduct(productId);
    if (!product) return;
    state.pick = { product, sizeId: product.sizes[0].id, qty: 1 };
    $('#pick-title').textContent = product.name;
    $('#pick-desc').textContent = product.description;
    $('#pick-dedication').value = '';
    $('#pick-sizes').innerHTML = product.sizes
      .map(
        (s, i) => `<label class="choice">
          <span><input type="radio" name="size" value="${esc(s.id)}" ${i === 0 ? 'checked' : ''}> ${esc(s.label)}</span>
          <b>${money(s.priceCents)}</b>
        </label>`
      )
      .join('');
    updatePick();
    pickDialog.showModal();
  }

  function updatePick() {
    const { product, sizeId, qty } = state.pick;
    const size = findSize(product, sizeId);
    $('#pick-qty').textContent = qty;
    $('#pick-minus').disabled = qty <= 1;
    $('#pick-plus').disabled = qty >= maxQty();
    $('#pick-total').textContent = money(size.priceCents * qty);
  }

  $('#pick-sizes').addEventListener('change', (e) => {
    if (e.target.name === 'size') {
      state.pick.sizeId = e.target.value;
      updatePick();
    }
  });
  $('#pick-minus').addEventListener('click', () => {
    state.pick.qty = Math.max(1, state.pick.qty - 1);
    updatePick();
  });
  $('#pick-plus').addEventListener('click', () => {
    state.pick.qty = Math.min(maxQty(), state.pick.qty + 1);
    updatePick();
  });

  $('#pick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { product, sizeId, qty } = state.pick;
    const dedication = $('#pick-dedication').value.replace(/\s+/g, ' ').trim().slice(0, 60);
    const same = state.cart.find((l) => l.productId === product.id && l.sizeId === sizeId && l.dedication === dedication);
    if (same) same.qty = Math.min(maxQty(), same.qty + qty);
    else state.cart.push({ productId: product.id, sizeId, qty, dedication });
    saveCart();
    pickDialog.close();
    renderCart();
    openCart();
  });

  /* ---------- Panel del pedido ---------- */

  const cartDialog = $('#cart-dialog');
  const cartBody = $('#cart-body');
  const cartFoot = $('#cart-foot');

  function openCart() {
    renderCart();
    if (!cartDialog.open) cartDialog.showModal();
  }

  function updateBadge() {
    const n = cartUnits();
    const badge = $('#cart-count');
    badge.innerHTML = `${n}<span class="visually-hidden"> ${n === 1 ? 'tarta' : 'tartas'} en el pedido</span>`;
    badge.classList.toggle('has-items', n > 0);
  }

  function renderCart() {
    updateBadge();

    if (state.cart.length === 0) {
      cartFoot.hidden = true;
      if (bodyMode !== 'empty') {
        bodyMode = 'empty';
        cartBody.innerHTML = `<div class="empty">
          <p>Todavía no has añadido ninguna tarta. Elige una del catálogo para empezar tu encargo.</p>
          <button class="button dark" type="button" data-close>Ver tartas <b>→</b></button>
        </div>`;
      }
      return;
    }

    if (bodyMode !== 'form') {
      bodyMode = 'form';
      cartBody.innerHTML = formHTML();
      bindForm();
    }
    renderItems();
    $('#cart-total').textContent = money(cartTotal());
    cartFoot.hidden = false;
    refreshAvailability();
  }

  function formHTML() {
    const c = state.config;
    const c0 = state.contact;
    return `
      <h3>Tu pedido</h3>
      <div id="cart-items"></div>

      <h3>Recogida en tienda</h3>
      <div class="field" id="field-pickupDate">
        <label for="f-date">Día de recogida</label>
        <input type="date" id="f-date" name="pickupDate" min="${esc(c.minDate)}" max="${esc(c.maxDate)}" value="${esc(state.date)}" aria-describedby="hint-date err-pickupDate">
        <p class="hint" id="hint-date">Los encargos necesitan ${esc(c.leadText)} de antelación.</p>
        <p class="field-error" id="err-pickupDate" hidden></p>
      </div>
      <div id="avail" aria-live="polite"></div>
      <fieldset class="field" id="field-pickupTime" hidden>
        <legend>Hora de recogida</legend>
        <div class="slots" id="slots"></div>
        <p class="field-error" id="err-pickupTime" hidden></p>
      </fieldset>

      <h3>Tus datos</h3>
      <div class="field" id="field-name">
        <label for="f-name">Nombre y apellidos</label>
        <input id="f-name" name="name" autocomplete="name" maxlength="80" value="${esc(c0.name)}" aria-describedby="err-name">
        <p class="field-error" id="err-name" hidden></p>
      </div>
      <div class="field" id="field-phone">
        <label for="f-phone">Teléfono</label>
        <input id="f-phone" name="phone" type="tel" autocomplete="tel" maxlength="30" value="${esc(c0.phone)}" aria-describedby="hint-phone err-phone">
        <p class="hint" id="hint-phone">Por si tenemos que avisarte de algo sobre tu tarta.</p>
        <p class="field-error" id="err-phone" hidden></p>
      </div>
      <div class="field" id="field-email">
        <label for="f-email">Email</label>
        <input id="f-email" name="email" type="email" autocomplete="email" maxlength="120" value="${esc(c0.email)}" aria-describedby="err-email">
        <p class="field-error" id="err-email" hidden></p>
      </div>
      <div class="field" id="field-notes">
        <label for="f-notes">Alergias u observaciones (opcional)</label>
        <textarea id="f-notes" name="notes" maxlength="300" aria-describedby="hint-notes err-notes">${esc(c0.notes)}</textarea>
        <p class="hint" id="hint-notes">Cuéntanos cualquier alergia o intolerancia.</p>
        <p class="field-error" id="err-notes" hidden></p>
      </div>
      <div class="field" id="field-acceptTerms">
        <label class="check">
          <input type="checkbox" id="f-accept" name="acceptTerms" ${c0.accept ? 'checked' : ''} aria-describedby="err-acceptTerms">
          <span>He leído y acepto las <a href="legal.html#condiciones" target="_blank" rel="noopener">condiciones del encargo</a> y la <a href="legal.html#privacidad" target="_blank" rel="noopener">política de privacidad</a>.</span>
        </label>
        <p class="field-error" id="err-acceptTerms" hidden></p>
      </div>
      <div class="form-error" id="form-error" role="alert" hidden></div>`;
  }

  function renderItems() {
    const wrap = $('#cart-items');
    wrap.innerHTML = state.cart
      .map((line, i) => {
        const info = lineInfo(line);
        if (!info) return '';
        return `<div class="cart-line">
          <strong>${esc(info.product.name)} · ${esc(info.size.label)}</strong>
          <span class="price">${money(info.size.priceCents * line.qty)}</span>
          <span class="meta">${line.dedication ? `Dedicatoria: «${esc(line.dedication)}»` : 'Sin dedicatoria'}</span>
          <div class="controls">
            <div class="qty" role="group" aria-label="Cantidad de ${esc(info.product.name)}">
              <button type="button" data-act="minus" data-i="${i}" aria-label="Quitar una" ${line.qty <= 1 ? 'disabled' : ''}>−</button>
              <output>${line.qty}</output>
              <button type="button" data-act="plus" data-i="${i}" aria-label="Añadir una" ${line.qty >= maxQty() ? 'disabled' : ''}>+</button>
            </div>
            <button class="link-button" type="button" data-act="remove" data-i="${i}">Quitar del pedido</button>
          </div>
        </div>`;
      })
      .join('');
  }

  function bindForm() {
    $('#cart-items').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const line = state.cart[i];
      if (!line) return;
      if (btn.dataset.act === 'plus') line.qty = Math.min(maxQty(), line.qty + 1);
      if (btn.dataset.act === 'minus') line.qty = Math.max(1, line.qty - 1);
      if (btn.dataset.act === 'remove') state.cart.splice(i, 1);
      saveCart();
      renderCart();
    });

    $('#f-date').addEventListener('change', (e) => {
      state.date = e.target.value;
      state.time = '';
      clearError('pickupDate');
      clearError('pickupTime');
      refreshAvailability();
    });
    $('#slots').addEventListener('change', (e) => {
      if (e.target.name === 'pickupTime') {
        state.time = e.target.value;
        clearError('pickupTime');
      }
    });

    const remember = (id, key, prop = 'value') =>
      $(id).addEventListener('input', (e) => {
        state.contact[key] = e.target[prop];
        clearError(key === 'accept' ? 'acceptTerms' : key);
      });
    remember('#f-name', 'name');
    remember('#f-phone', 'phone');
    remember('#f-email', 'email');
    remember('#f-notes', 'notes');
    remember('#f-accept', 'accept', 'checked');
  }

  /* ---------- Disponibilidad ---------- */

  async function refreshAvailability() {
    const avail = $('#avail');
    const slotsField = $('#field-pickupTime');
    if (!avail) return;
    if (!state.date) {
      avail.innerHTML = '';
      slotsField.hidden = true;
      return;
    }
    const seq = ++availabilitySeq;
    try {
      const data = await getJSON(`/api/availability?date=${encodeURIComponent(state.date)}&units=${cartUnits()}`);
      if (seq !== availabilitySeq) return; // llegó una respuesta más nueva
      if (!data.ok) {
        avail.innerHTML = `<p class="avail no">${esc(data.reason)}</p>`;
        slotsField.hidden = true;
        state.time = '';
        return;
      }
      const few = data.remaining !== null && data.remaining <= 5;
      avail.innerHTML = few
        ? `<p class="avail">${data.remaining === 1 ? 'Queda 1 tarta' : `Quedan ${data.remaining} tartas`} para ese día.</p>`
        : '';
      if (!data.slots.includes(state.time)) state.time = '';
      $('#slots').innerHTML = data.slots
        .map(
          (t) => `<label class="slot"><input type="radio" name="pickupTime" value="${t}" ${t === state.time ? 'checked' : ''}><span>${t}</span></label>`
        )
        .join('');
      slotsField.hidden = false;
    } catch {
      if (seq !== availabilitySeq) return;
      avail.innerHTML = '<p class="avail no">No hemos podido comprobar la disponibilidad. Inténtalo de nuevo.</p>';
      slotsField.hidden = true;
    }
  }

  /* ---------- Errores de formulario ---------- */

  function showError(field, message) {
    const el = $(`#err-${field}`);
    const wrap = $(`#field-${field}`);
    if (!el || !wrap) return false;
    el.textContent = message;
    el.hidden = false;
    wrap.classList.add('invalid');
    const input = wrap.querySelector('input:not([type=radio]), textarea');
    if (input) input.setAttribute('aria-invalid', 'true');
    return true;
  }

  function clearError(field) {
    const el = $(`#err-${field}`);
    const wrap = $(`#field-${field}`);
    if (!el || !wrap) return;
    el.hidden = true;
    wrap.classList.remove('invalid');
    wrap.querySelector('input:not([type=radio]), textarea')?.removeAttribute('aria-invalid');
  }

  function clearAllErrors() {
    ['pickupDate', 'pickupTime', 'name', 'phone', 'email', 'notes', 'acceptTerms'].forEach(clearError);
    const fe = $('#form-error');
    if (fe) fe.hidden = true;
  }

  function focusField(field) {
    const wrap = $(`#field-${field}`);
    const target = wrap?.querySelector('input:not([type=radio]), textarea') || wrap?.querySelector('input');
    target?.focus();
  }

  function validateLocally() {
    const errors = [];
    const c = state.contact;
    if (!state.date) errors.push(['pickupDate', 'Elige el día en que vendrás a recoger tu tarta.']);
    else if (!state.time && !$('#field-pickupTime').hidden) errors.push(['pickupTime', 'Elige la hora de recogida.']);
    else if (!state.time) errors.push(['pickupDate', 'Elige un día con disponibilidad.']);
    if (c.name.trim().length < 2) errors.push(['name', 'Escribe tu nombre.']);
    const digits = c.phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) errors.push(['phone', 'Escribe un teléfono válido, por ejemplo 951 005 306.']);
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) errors.push(['email', 'Escribe un email válido, por ejemplo nombre@correo.com.']);
    if (!c.accept) errors.push(['acceptTerms', 'Debes aceptar las condiciones para continuar.']);
    return errors;
  }

  /* ---------- Pago ---------- */

  const payButton = $('#pay-button');
  const payLabel = payButton.innerHTML;

  function setSubmitting(on) {
    state.submitting = on;
    payButton.disabled = on;
    payButton.innerHTML = on ? 'Abriendo el pago seguro…' : payLabel;
  }

  $('#checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.submitting || state.cart.length === 0) return;

    clearAllErrors();
    const errors = validateLocally();
    if (errors.length) {
      errors.forEach(([f, m]) => showError(f, m));
      focusField(errors[0][0]);
      return;
    }

    setSubmitting(true);
    try {
      const data = await getJSON('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: state.cart.map(({ productId, sizeId, qty, dedication }) => ({ productId, sizeId, qty, dedication })),
          pickupDate: state.date,
          pickupTime: state.time,
          name: state.contact.name,
          phone: state.contact.phone,
          email: state.contact.email,
          notes: state.contact.notes,
          acceptTerms: state.contact.accept
        })
      });
      if (typeof data.url !== 'string' || !data.url.startsWith('https://checkout.stripe.com/')) {
        throw new Error('No hemos podido iniciar el pago. Inténtalo de nuevo.');
      }
      window.location.href = data.url; // el botón queda bloqueado hasta salir de la página
    } catch (err) {
      setSubmitting(false);
      if (err.field && showError(err.field, err.message)) {
        focusField(err.field);
      } else {
        const box = $('#form-error');
        box.textContent = err.status === undefined ? 'No hemos podido conectar. Comprueba tu conexión e inténtalo de nuevo.' : err.message;
        box.hidden = false;
        box.scrollIntoView({ block: 'nearest' });
      }
      if (err.status === 409) {
        // Un producto ya no está disponible o el aforo cambió: refrescamos catálogo y disponibilidad.
        await loadProducts();
        reconcileCart();
        renderCart();
      }
    }
  });

  // Si el cliente vuelve atrás desde Stripe, el navegador puede restaurar la página con el botón bloqueado.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setSubmitting(false);
  });

  /* ---------- Diálogos: cerrar ---------- */

  for (const dialog of [pickDialog, cartDialog]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
    });
  }
  $('#open-cart').addEventListener('click', openCart);

  $('#catalog').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (btn) openPick(Number(btn.dataset.pick));
  });

  /* ---------- Arranque ---------- */

  async function loadProducts() {
    const { products } = await getJSON('/api/products');
    state.products = products;
  }

  function reconcileCart() {
    const before = state.cart.length;
    state.cart = state.cart.filter((l) => lineInfo(l));
    if (state.cart.length !== before) {
      saveCart();
      showNotice('Hemos quitado de tu pedido alguna tarta que ya no está disponible.');
    }
  }

  async function init() {
    try {
      const [, config] = await Promise.all([loadProducts(), getJSON('/api/config')]);
      state.config = config;
    } catch {
      $('#catalog-state').innerHTML =
        'No hemos podido cargar las tartas. Recarga la página o llámanos al <a href="tel:+34951005306">951 005 306</a>.';
      return;
    }

    const phoneLink = $('#phone-link');
    phoneLink.textContent = state.config.phone;
    phoneLink.href = `tel:${telHref()}`;
    $('#lead-note').textContent = `Los encargos necesitan ${state.config.leadText} de antelación.`;

    reconcileCart();
    renderCatalog();
    renderCart();

    const params = new URLSearchParams(location.search);
    if (params.get('cancelado') === '1') {
      showNotice('El pago no se ha completado y no se ha cobrado nada. Tu pedido sigue guardado por si quieres intentarlo de nuevo.');
      history.replaceState(null, '', location.pathname);
    }
  }

  updateBadge();
  init();
})();
