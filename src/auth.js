import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as db from './db.js';

const COOKIE = 'session';
const SESSION_DAYS = 60;

// PBKDF2 via Web Crypto. Workers cap iterations at 100,000. The count is
// stored with each hash so it can change later without breaking old logins.
const ITERATIONS = 100_000;

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [, iterations, salt, hash] = stored.split('$');
  const candidate = await pbkdf2(password, fromHex(salt), Number(iterations));
  const expected = fromHex(hash);
  return candidate.length === expected.length
    && crypto.subtle.timingSafeEqual(candidate, expected);
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startSession(c, memberId) {
  const token = newToken();
  await db.createSession(token, memberId, SESSION_DAYS);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export const sessionToken = (c) => getCookie(c, COOKIE);

export async function endSession(c) {
  const token = getCookie(c, COOKIE);
  if (token) await db.deleteSession(token);
  deleteCookie(c, COOKIE, { path: '/' });
}

// Puts the logged-in member (or null) on c.get('member').
export async function loadMember(c, next) {
  const token = getCookie(c, COOKIE);
  c.set('member', token ? (await db.getSessionMember(token)) ?? null : null);
  await next();
}

export async function requireMember(c, next) {
  if (!c.get('member')) return c.redirect('/login');
  await next();
}
