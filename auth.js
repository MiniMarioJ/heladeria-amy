'use strict';

const crypto = require('crypto');

const COOKIE = 'amy_admin';
const SESSION_HOURS = 12;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function createToken(secret, now = Date.now()) {
  const body = b64(JSON.stringify({ exp: now + SESSION_HOURS * 3600 * 1000 }));
  return `${body}.${sign(secret, body)}`;
}

function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [body, mac] = token.split('.');
  if (!body || !mac) return false;
  const expected = sign(secret, body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

/** Compara contraseñas en tiempo constante (se hashean antes para que la longitud no se filtre). */
function passwordMatches(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie mal formada: se ignora */
    }
  }
  return out;
}

function cookieHeader(value, { secure, maxAgeSeconds }) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : ''
  ]
    .filter(Boolean)
    .join('; ');
}

module.exports = {
  COOKIE,
  SESSION_HOURS,
  createToken,
  verifyToken,
  passwordMatches,
  parseCookies,
  cookieHeader
};
