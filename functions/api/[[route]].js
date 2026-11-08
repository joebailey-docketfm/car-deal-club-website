// Members' area API: login, invites, Ask Jim requests, Jim's admin and push subscriptions.
// /api/subscribe and /api/contact are separate files and take precedence over this catch-all.
import { hashPassword, verifyPassword, randomToken, sha256 } from '../_lib/crypto.js';
import { sendEmail, canEmail } from '../_lib/mail.js';
import { pushToAdmins, sendPush } from '../_lib/push.js';

const DAY = 86400000;
const SESSION_DAYS = 30;
const COOKIE = 'cdc_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const fail = (error, status = 400) => json({ ok: false, error }, status);
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

function cookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function readCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

async function currentUser(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.role, u.activated_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
}

async function startSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * DAY).run();
  return cookie(token, SESSION_DAYS * 86400);
}

// Fixed-window rate limit kept in D1. Returns true when the key is over its limit.
async function limited(env, key, limit) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM attempts WHERE key = ?').bind(key).first();
  return !!row && row.reset_at > Date.now() && row.count >= limit;
}
async function hit(env, key, windowMs) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO attempts (key, count, reset_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET ' +
    'count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END'
  ).bind(key, now + windowMs, now).run();
}
const clearHits = (env, key) => env.DB.prepare('DELETE FROM attempts WHERE key = ?').bind(key).run();

const ip = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';
const firstName = (name) => String(name || '').split(' ')[0];

async function issueToken(env, userId, kind) {
  const token = randomToken();
  const life = kind === 'invite' ? 7 * DAY : 60 * 60 * 1000;
  await env.DB.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(Date.now(), userId).run();
  await env.DB.prepare('INSERT INTO tokens (id, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, kind, Date.now() + life).run();
  return token;
}

async function findToken(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    'SELECT t.id, t.kind, u.id AS user_id, u.name, u.email, u.role FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.used_at IS NULL AND t.expires_at > ?'
  ).bind(await sha256(token), Date.now()).first();
}

async function loadRequests(env, where, bind) {
  const { results: reqs } = await env.DB.prepare(
    `SELECT r.id, r.question, r.car, r.area, r.status, r.created_at, r.updated_at, u.name, u.email FROM requests r JOIN users u ON u.id = r.user_id ${where} ORDER BY r.updated_at DESC`
  ).bind(...bind).all();
  if (!reqs.length) return [];
  const ids = reqs.map((r) => r.id);
  const { results: msgs } = await env.DB.prepare(
    `SELECT request_id, from_jim, body, created_at FROM messages WHERE request_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
  ).bind(...ids).all();
  return reqs.map((r) => ({
    id: r.id, q: r.question, car: r.car, area: r.area, status: r.status, created: r.created_at, updated: r.updated_at,
    name: r.name, email: r.email,
    msgs: msgs.filter((m) => m.request_id === r.id).map((m) => ({ me: !m.from_jim, at: m.created_at, text: m.body })),
  }));
}

// Tells Jim about a new request or a member's reply: push to his phone, email as the backup.
async function tellJim(env, origin, { title, body, id }) {
  const url = '/admin/#/admin/' + id;
  await Promise.all([
    pushToAdmins(env, { title, body: body.slice(0, 180), url }),
    sendEmail(env, { to: env.ADMIN_EMAIL, subject: title, text: `${title}\n\n${body}\n\nOpen it in your admin: ${origin}${url}\n` }),
  ]);
}

const routes = {
  'GET me': async ({ user }) => json({ ok: true, user: user && { name: user.name, email: user.email, role: user.role, joined: user.activated_at } }),

  'POST login': async ({ env, request, body }) => {
    const email = clean(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    const kEmail = 'login:e:' + email, kIp = 'login:i:' + ip(request);
    if ((await limited(env, kEmail, 5)) || (await limited(env, kIp, 30))) return fail('too_many', 429);
    const user = await env.DB.prepare('SELECT id, password_hash, role FROM users WHERE email = ?').bind(email).first();
    const okPw = await verifyPassword(password, user && user.password_hash);
    if (!user || !okPw || (body.admin && user.role !== 'admin')) {
      await hit(env, kEmail, 15 * 60000);
      await hit(env, kIp, 15 * 60000);
      return fail('wrong', 401);
    }
    await clearHits(env, kEmail);
    return json({ ok: true, role: user.role }, 200, { 'Set-Cookie': await startSession(env, user.id) });
  },

  'POST logout': async ({ env, request }) => {
    const token = readCookie(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  },

  'POST forgot': async ({ env, request, body, origin }) => {
    const email = clean(body.email, 200).toLowerCase();
    const kEmail = 'forgot:e:' + email, kIp = 'forgot:i:' + ip(request);
    if ((await limited(env, kEmail, 3)) || (await limited(env, kIp, 10))) return fail('too_many', 429);
    await hit(env, kEmail, 60 * 60000);
    await hit(env, kIp, 60 * 60000);
    const user = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (user) {
      const token = await issueToken(env, user.id, 'reset');
      await sendEmail(env, {
        to: email,
        subject: 'Reset your Car Deal Club password',
        text: `Hello ${firstName(user.name)},\n\nUse this link to choose a new password:\n\n${origin}/#/set-password/${token}\n\nThe link works once and expires in one hour. If you did not ask for this, you can ignore this email.\n\nCar Deal Club\n`,
      });
    }
    return json({ ok: true });
  },

  'POST token/check': async ({ env, request, body }) => {
    const kIp = 'token:i:' + ip(request);
    if (await limited(env, kIp, 30)) return fail('too_many', 429);
    const t = await findToken(env, String(body.token || ''));
    if (!t) { await hit(env, kIp, 15 * 60000); return fail('expired', 404); }
    return json({ ok: true, kind: t.kind, name: t.name, email: t.email, role: t.role });
  },

  'POST token/set-password': async ({ env, request, body }) => {
    const kIp = 'token:i:' + ip(request);
    if (await limited(env, kIp, 30)) return fail('too_many', 429);
    const password = String(body.password || '');
    if (password.length < 8 || password.length > 200) return fail('short');
    const t = await findToken(env, String(body.token || ''));
    if (!t) { await hit(env, kIp, 15 * 60000); return fail('expired', 404); }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').bind(now, t.id),
      env.DB.prepare('UPDATE users SET password_hash = ?, activated_at = COALESCE(activated_at, ?) WHERE id = ?').bind(await hashPassword(password), now, t.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.user_id),
    ]);
    return json({ ok: true, role: t.role }, 200, { 'Set-Cookie': await startSession(env, t.user_id) });
  },

  // Member: Ask Jim
  'GET requests': async ({ env, user }) => {
    if (!user) return fail('login', 401);
    return json({ ok: true, requests: await loadRequests(env, 'WHERE r.user_id = ?', [user.id]) });
  },

  'POST requests': async ({ env, user, body, origin, ctx }) => {
    if (!user) return fail('login', 401);
    const q = clean(body.q, 4000), car = clean(body.car, 200), area = clean(body.area, 200);
    if (q.length < 5) return fail('short');
    const now = Date.now();
    const r = await env.DB.prepare('INSERT INTO requests (user_id, question, car, area, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(user.id, q, car, area, 'sent', now, now).first();
    await env.DB.prepare('INSERT INTO messages (request_id, from_jim, body, created_at) VALUES (?, 0, ?, ?)').bind(r.id, q, now).run();
    const extra = [car, area].filter(Boolean).join(' · ');
    ctx.waitUntil(tellJim(env, origin, { title: 'New request from ' + user.name, body: q + (extra ? '\n\n' + extra : ''), id: r.id }));
    return json({ ok: true, id: r.id });
  },

  'POST requests/:id/reply': async ({ env, user, body, params, origin, ctx }) => {
    if (!user) return fail('login', 401);
    const text = clean(body.text, 4000);
    if (!text) return fail('empty');
    const r = await env.DB.prepare('SELECT id, status FROM requests WHERE id = ? AND user_id = ?').bind(params.id, user.id).first();
    if (!r) return fail('not_found', 404);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO messages (request_id, from_jim, body, created_at) VALUES (?, 0, ?, ?)').bind(r.id, text, now),
      env.DB.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').bind(r.status === 'answered' ? 'working' : r.status, now, r.id),
    ]);
    ctx.waitUntil(tellJim(env, origin, { title: user.name + ' replied', body: text, id: r.id }));
    return json({ ok: true });
  },

  // Jim's admin
  'GET admin/requests': async ({ env, admin }) => {
    if (!admin) return fail('login', 401);
    return json({ ok: true, requests: await loadRequests(env, '', []) });
  },

  'POST admin/requests/:id/reply': async ({ env, admin, body, params, origin, ctx }) => {
    if (!admin) return fail('login', 401);
    const text = clean(body.text, 6000);
    if (!text) return fail('empty');
    const status = body.status === 'answered' ? 'answered' : 'working';
    const r = await env.DB.prepare('SELECT r.id, r.question, u.email, u.name FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?').bind(params.id).first();
    if (!r) return fail('not_found', 404);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO messages (request_id, from_jim, body, created_at) VALUES (?, 1, ?, ?)').bind(r.id, text, now),
      env.DB.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, r.id),
    ]);
    ctx.waitUntil(sendEmail(env, {
      to: r.email,
      subject: 'Jim has replied to your request',
      text: `Hello ${firstName(r.name)},\n\nJim has replied to your request:\n"${r.question.slice(0, 300)}"\n\n${text}\n\nRead it and reply in your account: ${origin}/#/ask-jim/${r.id}\n\nCar Deal Club\n`,
    }));
    return json({ ok: true });
  },

  'GET admin/members': async ({ env, admin }) => {
    if (!admin) return fail('login', 401);
    const { results } = await env.DB.prepare(
      "SELECT u.name, u.email, u.created_at, u.activated_at, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) AS reqs FROM users u WHERE u.role = 'member' ORDER BY u.created_at DESC"
    ).all();
    return json({ ok: true, members: results });
  },

  'GET admin/waitlist': async ({ env, admin }) => {
    if (!admin) return fail('login', 401);
    const list = [];
    let cursor;
    do {
      const page = await env.SIGNUPS.list({ cursor });
      for (const k of page.keys) {
        const plain = !k.name.includes(':') && EMAIL_RE.test(k.name);
        if (!k.name.startsWith('waitlist:') && !plain) continue;
        let v = {};
        try { v = JSON.parse((await env.SIGNUPS.get(k.name)) || '{}'); } catch {}
        const email = String(v.email || k.name.replace(/^waitlist:/, '')).toLowerCase();
        list.push({ name: v.name || '', email, at: v.at || '' });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const { results } = await env.DB.prepare('SELECT email FROM users').all();
    const taken = new Set(results.map((r) => r.email));
    const seen = new Set();
    const out = list.filter((x) => !taken.has(x.email) && !seen.has(x.email) && seen.add(x.email)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json({ ok: true, waitlist: out });
  },

  'POST admin/invite': async ({ env, admin, body, origin }) => {
    if (!admin) return fail('login', 401);
    const email = clean(body.email, 200).toLowerCase();
    const name = clean(body.name, 120);
    if (!EMAIL_RE.test(email)) return fail('email');
    if (name.length < 2) return fail('name');
    let user = await env.DB.prepare('SELECT id, name, role FROM users WHERE email = ?').bind(email).first();
    if (user && user.role === 'admin') return fail('admin');
    if (!user) {
      user = await env.DB.prepare("INSERT INTO users (email, name, role, created_at) VALUES (?, ?, 'member', ?) RETURNING id, name")
        .bind(email, name, Date.now()).first();
    }
    const token = await issueToken(env, user.id, 'invite');
    const link = `${origin}/#/set-password/${token}`;
    const sent = await sendEmail(env, {
      to: email,
      subject: 'Your Car Deal Club membership',
      text: `Hello ${firstName(user.name)},\n\nJim has set up your Car Deal Club member account. Use this link to choose your password:\n\n${link}\n\nThe link works once and expires in 7 days. After that, log in at ${origin}/#/login with ${email}.\n\nCar Deal Club\n`,
    });
    return json({ ok: true, sent, link: sent ? null : link });
  },

  // Push subscriptions for Jim's phone
  'GET push/key': async ({ env }) => json({ ok: true, key: env.VAPID_PUBLIC || '' }),

  'POST push/subscribe': async ({ env, admin, body }) => {
    if (!admin) return fail('login', 401);
    const endpoint = clean(body.endpoint, 1000), p256dh = clean(body.keys && body.keys.p256dh, 200), auth = clean(body.keys && body.keys.auth, 100);
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return fail('invalid');
    await env.DB.prepare('INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
      .bind(endpoint, admin.id, p256dh, auth, Date.now()).run();
    return json({ ok: true });
  },

  'POST push/test': async ({ env, admin, body }) => {
    if (!admin) return fail('login', 401);
    const sub = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(clean(body.endpoint, 1000), admin.id).first();
    if (!sub) return fail('not_found', 404);
    const r = await sendPush(env, sub, { title: 'Car Deal Club', body: 'Notifications are working on this phone.', url: '/admin/#/admin' });
    return json({ ok: r === 'ok', error: r === 'ok' ? undefined : r });
  },

  'GET admin/status': async ({ env, admin }) => {
    if (!admin) return fail('login', 401);
    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').bind(admin.id).first();
    return json({ ok: true, email: canEmail(env, env.ADMIN_EMAIL), push: !!env.VAPID_PRIVATE_JWK, devices: subs.n });
  },
};

function match(method, path) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const a = pattern.split('/'), b = path.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    if (a.every((seg, i) => (seg.startsWith(':') ? /^\d+$/.test(b[i]) && (params[seg.slice(1)] = Number(b[i])) : seg === b[i]))) {
      return { handler: routes[key], params };
    }
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const found = match(request.method, path);
  if (!found) return fail('not_found', 404);

  let body = {};
  if (request.method !== 'GET') {
    // Cross-site form posts can't send JSON, and the Origin check stops other sites calling the API.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return fail('origin', 403);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return fail('json', 415);
    try { body = await request.json(); } catch { return fail('json'); }
  }

  const user = await currentUser(env, request);
  const admin = user && user.role === 'admin' ? user : null;
  try {
    return await found.handler({ env, request, body, user, admin, params: found.params, origin: url.origin, ctx: context });
  } catch (e) {
    console.error(e);
    return fail('server', 500);
  }
}
