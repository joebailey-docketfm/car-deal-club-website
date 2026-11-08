// Checks the RFC 8291 payload encryption by decrypting it as a browser would,
// written independently here with Node's crypto module.
import nodeCrypto from 'node:crypto';
import { encrypt } from '../functions/_lib/push.js';

const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const msg = JSON.stringify({ title: 'New request from Sam', body: 'Where is my cheapest set of tyres?' });
const body = Buffer.from(await encrypt({ p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, msg));

const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
const ecdh = ua.computeSecret(asPublic);
const hk = (s, ikm, info, n) => Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, info, n));
const ikm = hk(auth, ecdh, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(cipher.subarray(cipher.length - 16));
const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
if (rs !== 4096 || idlen !== 65 || plain[plain.length - 1] !== 2 || plain.subarray(0, -1).toString() !== msg) throw new Error('Mismatch');
console.log('PASS push payload decrypts to the original message');
