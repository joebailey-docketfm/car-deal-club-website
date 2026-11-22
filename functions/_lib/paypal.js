// Checks that a webhook really came from PayPal, without the PayPal Secret.
// PayPal signs "<transmission id>|<time>|<webhook id>|<CRC32 of the body>" with the key in the
// certificate at paypal-cert-url. We fetch that certificate (only from paypal.com), take its
// public key and check the signature with WebCrypto.
// https://developer.paypal.com/api/rest/webhooks/rest/#link-selfverificationmethod

const certCache = new Map();

let crcTable;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal DER reader: enough to walk an X.509 certificate to its SubjectPublicKeyInfo.
function readTlv(der, pos) {
  const tag = der[pos];
  let len = der[pos + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[pos + 2 + i];
    hdr = 2 + n;
  }
  return { tag, start: pos, body: pos + hdr, end: pos + hdr + len };
}

export function spkiFromCert(der) {
  const cert = readTlv(der, 0);                 // Certificate
  const tbs = readTlv(der, cert.body);          // TBSCertificate
  let p = tbs.body;
  let el = readTlv(der, p);
  if (el.tag === 0xa0) { p = el.end; }          // optional [0] version
  for (let i = 0; i < 5; i++) p = readTlv(der, p).end; // serial, signature alg, issuer, validity, subject
  const spki = readTlv(der, p);
  if (spki.tag !== 0x30) throw new Error('no public key in certificate');
  return der.slice(spki.start, spki.end);
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----[\s\S]*/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function publicKey(certUrl, fetcher) {
  if (certCache.has(certUrl)) return certCache.get(certUrl);
  const res = await fetcher(certUrl);
  if (!res.ok) throw new Error('certificate fetch failed ' + res.status);
  const key = await crypto.subtle.importKey('spki', spkiFromCert(pemToDer(await res.text())), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  certCache.set(certUrl, key);
  return key;
}

// Certificates must come from PayPal over HTTPS.
export function trustedCertUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'));
  } catch { return false; }
}

// Returns true when the headers carry a valid PayPal signature for this exact body and webhook.
export async function verifyWebhook(headers, rawBody, webhookId, fetcher = fetch) {
  const id = headers.get('paypal-transmission-id'), time = headers.get('paypal-transmission-time');
  const sig = headers.get('paypal-transmission-sig'), certUrl = headers.get('paypal-cert-url');
  const algo = headers.get('paypal-auth-algo') || '';
  if (!id || !time || !sig || !certUrl || !webhookId) return false;
  if (!/SHA256withRSA/i.test(algo) || !trustedCertUrl(certUrl)) return false;
  const message = `${id}|${time}|${webhookId}|${crc32(rawBody)}`;
  let sigBytes;
  try {
    const bin = atob(sig);
    sigBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  } catch { return false; }
  const key = await publicKey(certUrl, fetcher);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, new TextEncoder().encode(message));
}
