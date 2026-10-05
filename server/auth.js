/* TAMA-PIX accounts: bcrypt password hashes, random session tokens in an httpOnly cookie (only an HMAC of the token
 * is stored, keyed with SESSION_SECRET), simple in-memory rate limits, friend codes. */
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'tp_sid';
const SESSION_DAYS = 60, GUEST_DAYS = 365;
const BCRYPT_COST = +process.env.BCRYPT_COST || 10;
let SECRET = process.env.SESSION_SECRET || '';
const PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
if (!SECRET) {
  if (PROD) {
    SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('WARNING: SESSION_SECRET is not set - using a random one, so everyone is logged out when the server restarts.');
  } else SECRET = 'tamapix-local-dev-only';        // local dev: sessions survive restarts; production must set SESSION_SECRET
}

const keyOf = (token) => crypto.createHmac('sha256', SECRET).update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newFriendCode() { let s = 'PX-'; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s; }

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
const checkPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

const USER_RE = /^[a-z0-9_]{3,16}$/;
function checkCredentials(username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!USER_RE.test(u)) return [null, 'Username: 3-16 letters, numbers or _'];
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return [null, 'Password: at least 8 characters'];
  return [u, null];
}
function checkBirthYear(v) {
  if (v === '' || v == null) return [null, null];
  const y = Math.floor(+v), now = new Date().getFullYear();
  if (!Number.isFinite(y) || y < now - 120 || y > now) return [undefined, 'Birth year looks wrong'];
  return [y, null];
}

function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted); }
function sessionCookie(req, token, days) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${isHttps(req) || PROD ? '; Secure' : ''}`;
}
function clearCookie(req) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) || PROD ? '; Secure' : ''}`; }
function tokenFrom(req) { return parseCookies(req.headers.cookie)[COOKIE] || null; }

/** Fixed-window rate limiter: allow(key) -> true/false. */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, Math.max(10000, windowMs)).unref();
  return (key) => {
    const now = Date.now(); let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    return ++h.n <= max;
  };
}

module.exports = { COOKIE, SESSION_DAYS, GUEST_DAYS, PROD, keyOf, newToken, newFriendCode, hashPassword, checkPassword, checkCredentials,
                   checkBirthYear, sessionCookie, clearCookie, tokenFrom, limiter };
