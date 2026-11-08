// POST /api/contact  { name, email, message }
// Saves to the SIGNUPS KV namespace, and emails enquiries@ if RESEND_API_KEY is set.
import { notify } from '../_notify.js';

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  const at = new Date().toISOString();
  await env.SIGNUPS.put('contact:' + at + ':' + email, JSON.stringify({ name, email, message, at }));
  await notify(env, {
    subject: 'Website enquiry from ' + name,
    text: `Name: ${name}\nEmail: ${email}\nWhen: ${at}\n\n${message}`,
    replyTo: email,
  });
  return Response.json({ ok: true });
}
