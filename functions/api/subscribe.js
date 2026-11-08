// POST /api/subscribe  { name, email }  -> waiting list
// Saves to the SIGNUPS KV namespace, and emails enquiries@ if RESEND_API_KEY is set.
import { notify } from '../_notify.js';

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  }
  const at = new Date().toISOString();
  await env.SIGNUPS.put('waitlist:' + email, JSON.stringify({ name, email, at }));
  await notify(env, {
    subject: 'New waiting list sign-up: ' + (name || email),
    text: `Name: ${name}\nEmail: ${email}\nWhen: ${at}`,
    replyTo: email,
  });
  return Response.json({ ok: true });
}
