// Shared by the members' API and the PayPal webhook.
import { randomToken, sha256 } from './crypto.js';
import { sendEmail } from './mail.js';
import { pushToAdmins } from './push.js';

export const DAY = 86400000;
export const firstName = (name) => String(name || '').split(' ')[0];

// Invite links last 7 days, reset links an hour. A new token normally cancels any unused ones;
// keepOthers leaves them, so the link shown after paying does not break the emailed one.
export async function issueToken(env, userId, kind, keepOthers = false) {
  const token = randomToken();
  const life = kind === 'invite' ? 7 * DAY : 60 * 60 * 1000;
  if (!keepOthers) await env.DB.prepare('UPDATE tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(Date.now(), userId).run();
  await env.DB.prepare('INSERT INTO tokens (id, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, kind, Date.now() + life).run();
  return token;
}

// Push to John's phone and email every admin account.
export async function tellAdmins(env, origin, { title, body, url }) {
  const { results: admins } = await env.DB.prepare("SELECT email FROM users WHERE role = 'admin'").all();
  await Promise.all([
    pushToAdmins(env, { title, body: body.slice(0, 180), url }),
    ...admins.map((a) => sendEmail(env, { to: a.email, subject: title, text: `${title}\n\n${body}\n\nOpen your admin: ${origin}${url}\n` })),
  ]);
}

// A member whose PayPal access has run out. Members John invited by hand have no paid_until.
export const lapsed = (u) => !!u && u.role === 'member' && u.paid_until != null && u.paid_until < Date.now();
