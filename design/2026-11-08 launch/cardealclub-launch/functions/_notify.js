// Sends a notification email through Resend (resend.com) when RESEND_API_KEY is set.
// If it isn't set, or sending fails, the form still succeeds: everything is in KV.
export async function notify(env, { subject, text, replyTo }) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Car Deal Club website <website@cardealclub.co.uk>',
        to: [env.MAIL_TO || 'enquiries@cardealclub.co.uk'],
        reply_to: replyTo,
        subject,
        text,
      }),
    });
  } catch {}
}
