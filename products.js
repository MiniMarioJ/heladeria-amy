'use strict';

const { ApiError } = require('./errors');

function toApi(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sizes: JSON.parse(row.sizes).map((s) => ({ id: s.id, label: s.label, priceCents: s.price_cents })),
    color: row.color,
    image: row.image,
    active: !!row.active,
    sort: row.sort,
    sample: !!row.sample
  };
}

function clean(v, max, label, { min = 0 } = {}) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < min) throw new ApiError(400, `Escribe ${label}.`);
  if (s.length > max) throw new ApiError(400, `Máximo ${max} caracteres en ${label}.`);
  return s;
}

function validate(input) {
  if (!input || typeof input !== 'object') throw new ApiError(400, 'Datos no válidos.');

  const name = clean(input.name, 80, 'el nombre del producto', { min: 2 });
  const description = clean(input.description, 300, 'la descripción');

  if (!Array.isArray(input.sizes) || input.sizes.length < 1 || input.sizes.length > 6) {
    throw new ApiError(400, 'Añade entre 1 y 6 tamaños con su precio.');
  }
  const sizes = input.sizes.map((s, i) => {
    const price = Number(s?.priceCents);
    if (!Number.isInteger(price) || price < 100 || price > 100000) {
      throw new ApiError(400, 'Cada precio debe estar entre 1 € y 1.000 €.');
    }
    return { id: `s${i + 1}`, label: clean(s?.label, 40, 'el nombre del tamaño', { min: 1 }), price_cents: price };
  });

  const color = String(input.color || '#f3ccb7');
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ApiError(400, 'El color debe tener formato #rrggbb.');

  const image = String(input.image || '').trim();
  if (image && (!/^assets\/[A-Za-z0-9_\-./]+$/.test(image) || image.includes('..'))) {
    throw new ApiError(400, 'La imagen debe ser una ruta dentro de la carpeta assets, por ejemplo assets/tarta-oreo.jpg.');
  }

  const sort = Number.isInteger(Number(input.sort)) ? Number(input.sort) : 0;

  return { name, description, sizes: JSON.stringify(sizes), color, image, active: input.active ? 1 : 0, sort };
}

function listPublic(db) {
  return db
    .prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id')
    .all()
    .map(toApi)
    .map(({ active, sample, sort, ...rest }) => rest);
}

function listAll(db) {
  return db.prepare('SELECT * FROM products ORDER BY sort, id').all().map(toApi);
}

function create(db, input) {
  const p = validate(input);
  const info = db
    .prepare(
      `INSERT INTO products (name, description, sizes, color, image, active, sort, sample, created_at)
       VALUES (@name, @description, @sizes, @color, @image, @active, @sort, 0, @now)`
    )
    .run({ ...p, now: Date.now() });
  return toApi(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
}

function update(db, id, input) {
  const p = validate(input);
  // Al editar un producto de ejemplo se considera revisado (deja de mostrarse el aviso de precios provisionales).
  const info = db
    .prepare(
      `UPDATE products SET name=@name, description=@description, sizes=@sizes, color=@color,
              image=@image, active=@active, sort=@sort, sample=0 WHERE id=@id`
    )
    .run({ ...p, id });
  if (info.changes === 0) throw new ApiError(404, 'Producto no encontrado.');
  return toApi(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function remove(db, id) {
  // Los pedidos guardan una copia del nombre y el precio, así que borrar un producto no altera el historial.
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (info.changes === 0) throw new ApiError(404, 'Producto no encontrado.');
}

module.exports = { listPublic, listAll, create, update, remove };
