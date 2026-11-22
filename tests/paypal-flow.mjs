// Runs the PayPal join flow against the real API code and migrations, with SQLite standing in for D1.
// Usage: node tests/paypal-flow.mjs
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { crc32 } from '../functions/_lib/paypal.js';
import { onRequest as api } from '../functions/api/[[route]].js';
import { onRequestPost as webhook } from '../functions/api/paypal/webhook.js';

// Workers has crypto.subtle.timingSafeEqual; Node does not.
crypto.subtle.timingSafeEqual ??= (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// D1 shim
const db = new DatabaseSync(':memory:');
// Start from the launch database; the code adds the PayPal tables itself, as it will on the real site.
db.exec(fs.readFileSync('migrations/0001_init.sql', 'utf8'));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };

// Signed webhooks from a locally made "PayPal" certificate
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-pp-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '2', '-subj', '/CN=test'], { stdio: 'ignore' });
const CERT = 'https://api.paypal.com/v1/notifications/certs/CERT-test', pem = fs.readFileSync(dir + '/c.pem', 'utf8'), key = fs.readFileSync(dir + '/k.pem', 'utf8');
globalThis.fetch = async (u) => { if (String(u) === CERT) return new Response(pem); throw new Error('unexpected fetch ' + u); };

const env = { DB, PAYPAL_CLIENT_ID: 'client', PAYPAL_PLAN_ID: 'P-TEST', PAYPAL_WEBHOOK_ID: 'WH-ID', SITE_URL: 'https://example.test' };
const ctx = { waitUntil: () => {} };
const BASE = 'https://example.test';
async function call(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': '1.2.3.4' };
  if (cookie) headers.Cookie = cookie;
  const res = await api({ request: new Request(BASE + '/api/' + p, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env, ...ctx });
  return { status: res.status, json: await res.json(), cookie: res.headers.get('Set-Cookie') };
}
let n = 0;
async function send(type, resource, signed = true) {
  const raw = Buffer.from(JSON.stringify({ id: 'WH-EVT-' + (++n), event_type: type, resource }));
  const tid = 'tid-' + n, time = new Date().toISOString();
  const sig = crypto.sign('sha256', Buffer.from(`${tid}|${time}|${env.PAYPAL_WEBHOOK_ID}|${crc32(raw)}`), key).toString('base64');
  const headers = { 'paypal-transmission-id': tid, 'paypal-transmission-time': time, 'paypal-transmission-sig': signed ? sig : 'AAAA', 'paypal-cert-url': CERT, 'paypal-auth-algo': 'SHA256withRSA', 'Content-Type': 'application/json' };
  const res = await webhook({ request: new Request(BASE + '/api/paypal/webhook', { method: 'POST', headers, body: raw }), env });
  return { status: res.status, raw, headers };
}
const user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const ok = (m) => console.log('ok  ' + m);

const { ensureSchema } = await import('../functions/_lib/schema.js');
await ensureSchema(env); await ensureSchema(env);
assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'paid_until')); ok('database updates itself');

let r = await call('GET', 'join/config');
assert.deepEqual([r.json.paypal, r.json.planId], [true, 'P-TEST']); ok('config offers PayPal');

r = await call('POST', 'join/start', { name: 'Sam Driver', email: 'Sam@Example.com', agree: false });
assert.equal(r.json.error, 'agree'); ok('terms must be agreed');
r = await call('POST', 'join/start', { name: 'Sam Driver', email: 'Sam@Example.com', agree: true });
assert.ok(r.json.ok && r.json.id.startsWith('cdc-')); const { id, key: skey } = r.json; ok('sign-up started');

r = await call('POST', 'join/status', { id, key: 'wrong' });
assert.equal(r.status, 404); ok('status needs the browser key');
r = await call('POST', 'join/status', { id, key: skey });
assert.equal(r.json.state, 'waiting'); ok('waiting before PayPal confirms');

const sub = { id: 'I-SUB1', custom_id: id, status: 'ACTIVE', billing_info: { next_billing_time: new Date(Date.now() + 30 * 864e5).toISOString() } };
assert.equal((await send('BILLING.SUBSCRIPTION.ACTIVATED', sub, false)).status, 400); ok('unsigned webhook refused');
assert.equal(user('sam@example.com'), undefined);
const first = await send('BILLING.SUBSCRIPTION.ACTIVATED', sub);
assert.equal(first.status, 200);
let u = user('sam@example.com');
assert.equal(u.paypal_sub, 'I-SUB1'); assert.equal(u.paypal_status, 'ACTIVE'); assert.ok(u.paid_until > Date.now() + 30 * 864e5); ok('activation creates the member');
const again = await webhook({ request: new Request(BASE + '/api/paypal/webhook', { method: 'POST', headers: first.headers, body: first.raw }), env });
assert.equal(again.status, 200); assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1); ok('resent event is not applied twice');

r = await call('POST', 'join/status', { id, key: skey });
assert.equal(r.json.state, 'active'); assert.ok(r.json.token); ok('joining browser gets a set-password link');
r = await call('POST', 'token/set-password', { token: r.json.token, password: 'a-long-password' });
assert.ok(r.json.ok); const cookie = r.cookie.split(';')[0]; ok('member sets a password and is logged in');
r = await call('GET', 'me', null, cookie);
assert.equal(r.json.user.email, 'sam@example.com');
r = await call('POST', 'join/status', { id, key: skey });
assert.equal(r.json.state, 'done'); ok('status then says done');

r = await call('POST', 'join/start', { name: 'Sam Driver', email: 'sam@example.com', agree: true });
assert.equal(r.json.error, 'member'); ok('an active member cannot join twice');
db.exec("INSERT INTO users (email, name, role, created_at) VALUES ('john@example.test', 'John', 'admin', 0)");
r = await call('POST', 'join/start', { name: 'John', email: 'john@example.test', agree: true });
assert.equal(r.json.error, 'admin'); ok('the admin email cannot be used to join');

await send('PAYMENT.SALE.COMPLETED', { id: 'SALE1', billing_agreement_id: 'I-SUB1' }); ok('monthly payment handled');
await send('BILLING.SUBSCRIPTION.CANCELLED', { id: 'I-SUB1' });
u = user('sam@example.com'); assert.equal(u.paypal_status, 'CANCELLED'); assert.ok(u.paid_until > Date.now());
r = await call('GET', 'me', null, cookie); assert.equal(r.json.user.email, 'sam@example.com'); ok('cancelled member keeps access until paid month ends');

await send('BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-SUB1' });
r = await call('GET', 'me', null, cookie); assert.equal(r.json.user, null); ok('suspended member is logged out');
r = await call('POST', 'login', { email: 'sam@example.com', password: 'a-long-password', remember: true });
assert.deepEqual([r.status, r.json.error], [403, 'lapsed']); ok('lapsed member sees membership ended at login');

r = await call('POST', 'join/start', { name: 'Sam Driver', email: 'sam@example.com', agree: true });
assert.ok(r.json.ok); const re = r.json;
await send('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-SUB2', custom_id: re.id, billing_info: {} });
u = user('sam@example.com'); assert.equal(u.paypal_sub, 'I-SUB2'); assert.ok(u.paid_until > Date.now());
r = await call('POST', 'login', { email: 'sam@example.com', password: 'a-long-password', remember: true });
assert.ok(r.json.ok); ok('rejoining restores access with the same login');

await send('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-OTHER', custom_id: 'cdc-from-other-site' });
assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE role = \'member\'').get().n, 1); ok('subscriptions from the other environment are ignored');

console.log('paypal-flow: all checks passed');
