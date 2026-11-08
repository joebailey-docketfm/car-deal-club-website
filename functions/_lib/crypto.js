// Password hashing, random tokens and base64url helpers. WebCrypto only, so it runs on Workers.
// PBKDF2-SHA256 at 100,000 iterations, the most Workers allows.

const ITERATIONS = 100000;
const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

// A stored hash for unknown emails, so a wrong email takes as long as a wrong password.
const DUMMY = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = (stored || DUMMY).split('$');
  if (scheme !== 'pbkdf2') return false;
  const got = await pbkdf2(password, fromB64url(salt), Number(iter));
  const want = fromB64url(hash);
  if (got.length !== want.length) return false;
  return crypto.subtle.timingSafeEqual(got, want) && !!stored;
}
