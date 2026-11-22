// PayPal tells the site about subscriptions here. Registered in PayPal as a webhook for this
// environment; its ID is PAYPAL_WEBHOOK_ID. Every message is checked against PayPal's signature.
//
// ACTIVATED      a sign-up from our Join page has paid: create the member and email a password link
// PAYMENT.SALE   a monthly payment went through: extend access by a month
// CANCELLED      the member cancelled: access stays until the end of the month they paid for
// SUSPENDED      PayPal gave up after failed payments: access closes now
// EXPIRED        the subscription ended: access closes now
// RE-ACTIVATED   John or PayPal restarted it: access is back
//
// Both the live site and the preview get every event from Jim's PayPal account. Each one only acts
// on subscriptions that started on its own Join page (matched by custom_id) and ignores the rest.
import { verifyWebhook } from '../../_lib/paypal.js';
import { sendEmail } from '../../_lib/mail.js';
import { DAY, firstName, issueToken, tellAdmins } from '../../_lib/members.js';
import { ensureSchema } from '../../_lib/schema.js';

const ok = () => new Response('ok', { status: 200 });
const GRACE = 2 * DAY;

function accessUntil(resource) {
  const next = Date.parse(resource && resource.billing_info && resource.billing_info.next_billing_time);
  return (Number.isFinite(next) ? next : Date.now() + 31 * DAY) + GRACE;
}

async function activated(env, origin, sub) {
  const signup = sub.custom_id ? await env.DB.prepare('SELECT id, name, email, user_id FROM signups WHERE id = ?').bind(sub.custom_id).first() : null;
  if (!signup) return 'ignored';
  const now = Date.now(), until = accessUntil(sub);
  let user = await env.DB.prepare('SELECT id, name, email, activated_at FROM users WHERE email = ?').bind(signup.email).first();
  if (user) {
    await env.DB.prepare("UPDATE users SET paypal_sub = ?, paypal_status = 'ACTIVE', paid_until = ? WHERE id = ?").bind(sub.id, until, user.id).run();
  } else {
    user = await env.DB.prepare("INSERT INTO users (email, name, role, created_at, paypal_sub, paypal_status, paid_until) VALUES (?, ?, 'member', ?, ?, 'ACTIVE', ?) RETURNING id, name, email, activated_at")
      .bind(signup.email, signup.name, now, sub.id, until).first();
  }
  await env.DB.prepare('UPDATE signups SET user_id = ?, sub_id = ? WHERE id = ?').bind(user.id, sub.id, signup.id).run();

  if (user.activated_at) {
    await sendEmail(env, {
      to: user.email,
      subject: 'Welcome back to Car Deal Club',
      text: `Hello ${firstName(user.name)},\n\nThanks for rejoining Car Deal Club. Your membership is active again.\n\nLog in at ${origin}/#/login with ${user.email}.\n\nCar Deal Club\n`,
    });
  } else {
    const token = await issueToken(env, user.id, 'invite', true);
    await sendEmail(env, {
      to: user.email,
      subject: 'Welcome to Car Deal Club',
      text: `Hello ${firstName(user.name)},\n\nThanks for joining Car Deal Club. Your membership is active.\n\nUse this link to choose your password:\n\n${origin}/#/set-password/${token}\n\nThe link works once and expires in 7 days. After that, log in at ${origin}/#/login with ${user.email}, or use Forgot password.\n\nYou can cancel any time in your PayPal account.\n\nCar Deal Club\n`,
    });
  }
  await tellAdmins(env, origin, { title: 'New member: ' + user.name, body: `${user.name} (${user.email}) has joined through PayPal.\nPayPal subscription: ${sub.id}`, url: '/admin/#/admin-members' });
  return 'member ' + user.id;
}

async function byStatus(env, origin, sub, status) {
  const user = await env.DB.prepare('SELECT id, name, email, paid_until FROM users WHERE paypal_sub = ?').bind(sub.id).first();
  if (!user) return 'ignored';
  if (status === 'CANCELLED') {
    await env.DB.prepare("UPDATE users SET paypal_status = 'CANCELLED' WHERE id = ?").bind(user.id).run();
    const ends = new Date(user.paid_until || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    await tellAdmins(env, origin, { title: 'Membership cancelled: ' + user.name, body: `${user.name} (${user.email}) cancelled in PayPal. Their access ends on ${ends}.\nPayPal subscription: ${sub.id}`, url: '/admin/#/admin-members' });
  } else if (status === 'ACTIVE') {
    await env.DB.prepare("UPDATE users SET paypal_status = 'ACTIVE', paid_until = MAX(COALESCE(paid_until, 0), ?) WHERE id = ?").bind(accessUntil(sub), user.id).run();
  } else {
    await env.DB.prepare('UPDATE users SET paypal_status = ?, paid_until = ? WHERE id = ?').bind(status, Date.now() - 1, user.id).run();
    await tellAdmins(env, origin, { title: 'Membership ended: ' + user.name, body: `${user.name} (${user.email}): PayPal says the subscription is ${status.toLowerCase()}. Their access has closed.\nPayPal subscription: ${sub.id}`, url: '/admin/#/admin-members' });
  }
  return status.toLowerCase() + ' ' + user.id;
}

async function paid(env, sale) {
  const subId = sale.billing_agreement_id;
  if (!subId) return 'ignored';
  const r = await env.DB.prepare("UPDATE users SET paid_until = MAX(COALESCE(paid_until, 0), ?), paypal_status = CASE WHEN paypal_status = 'CANCELLED' THEN paypal_status ELSE 'ACTIVE' END WHERE paypal_sub = ?")
    .bind(Date.now() + 31 * DAY + GRACE, subId).run();
  return r.meta && r.meta.changes ? 'extended' : 'ignored';
}

export async function onRequestPost({ request, env }) {
  const raw = new Uint8Array(await request.arrayBuffer());
  let valid = false;
  try { valid = await verifyWebhook(request.headers, raw, env.PAYPAL_WEBHOOK_ID); } catch (e) { console.error('paypal verify', e.message); }
  if (!valid) return new Response('bad signature', { status: 400 });

  await ensureSchema(env);
  let event;
  try { event = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response('bad json', { status: 400 }); }
  const seen = await env.DB.prepare('SELECT id FROM paypal_events WHERE id = ?').bind(event.id).first();
  if (seen) return ok();

  const origin = env.SITE_URL || new URL(request.url).origin;
  const res = event.resource || {};
  let outcome = 'ignored';
  switch (event.event_type) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED': outcome = await activated(env, origin, res); break;
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED': outcome = await byStatus(env, origin, res, 'ACTIVE'); break;
    case 'BILLING.SUBSCRIPTION.CANCELLED': outcome = await byStatus(env, origin, res, 'CANCELLED'); break;
    case 'BILLING.SUBSCRIPTION.SUSPENDED': outcome = await byStatus(env, origin, res, 'SUSPENDED'); break;
    case 'BILLING.SUBSCRIPTION.EXPIRED': outcome = await byStatus(env, origin, res, 'EXPIRED'); break;
    case 'PAYMENT.SALE.COMPLETED': outcome = await paid(env, res); break;
  }
  // Only remembered once handled, so if anything above fails PayPal sends it again.
  await env.DB.prepare('INSERT OR IGNORE INTO paypal_events (id, type, created_at) VALUES (?, ?, ?)').bind(event.id, event.event_type, Date.now()).run();
  console.log('paypal', event.event_type, outcome);
  return ok();
}
