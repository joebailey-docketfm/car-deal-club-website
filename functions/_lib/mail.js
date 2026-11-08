// Email through Car Deal Club's own Resend account (RESEND_API_KEY secret).
// Returns true only when Resend accepted the email. Callers fall back to showing a link.

export function canEmail(env, to) {
  if (!env.RESEND_API_KEY) return false;
  if (env.EMAIL_ALLOW) return env.EMAIL_ALLOW.split(',').map((s) => s.trim().toLowerCase()).includes(to.toLowerCase());
  return true;
}

export async function sendEmail(env, { to, subject, text }) {
  if (!canEmail(env, to)) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Car Deal Club <website@cardealclub.co.uk>',
        to: [to],
        reply_to: env.REPLY_TO || 'enquiries@cardealclub.co.uk',
        subject,
        text,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
