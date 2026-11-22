// Checks the PayPal webhook signature code against a locally made certificate.
// Usage: node tests/paypal-verify.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyWebhook, crc32, trustedCertUrl } from '../functions/_lib/paypal.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-pp-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '2', '-subj', '/CN=messageverificationcerts.paypal.com'], { stdio: 'ignore' });
const pem = fs.readFileSync(dir + '/c.pem', 'utf8'), key = fs.readFileSync(dir + '/k.pem', 'utf8');

assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
assert.ok(trustedCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-1'));
assert.ok(!trustedCertUrl('https://api.paypal.com.evil.example/c'));
assert.ok(!trustedCertUrl('http://api.paypal.com/c'));

const body = new TextEncoder().encode(JSON.stringify({ id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' }));
const wid = 'WEBHOOK123', tid = 'abc-123', time = new Date().toISOString(), certUrl = 'https://api.paypal.com/v1/notifications/certs/CERT-test';
const sig = crypto.sign('sha256', Buffer.from(`${tid}|${time}|${wid}|${crc32(body)}`), key).toString('base64');
const headers = (over = {}) => new Headers({ 'paypal-transmission-id': tid, 'paypal-transmission-time': time, 'paypal-transmission-sig': sig, 'paypal-cert-url': certUrl, 'paypal-auth-algo': 'SHA256withRSA', ...over });
const fetcher = async (u) => { assert.equal(u, certUrl); return new Response(pem); };

assert.equal(await verifyWebhook(headers(), body, wid, fetcher), true, 'good signature');
assert.equal(await verifyWebhook(headers(), body, 'OTHER', fetcher), false, 'wrong webhook id');
assert.equal(await verifyWebhook(headers(), new TextEncoder().encode('{"id":"WH-2"}'), wid, fetcher), false, 'changed body');
assert.equal(await verifyWebhook(headers({ 'paypal-cert-url': 'https://evil.example/c' }), body, wid, fetcher), false, 'untrusted cert host');
assert.equal(await verifyWebhook(headers({ 'paypal-transmission-sig': 'bm90IGEgc2ln' }), body, wid, fetcher), false, 'bad signature');
console.log('paypal-verify: all checks passed');
