# Car Deal Club website

Car Deal Club is a separate business run by Joe and Jim. It has no relation to docket.

Nothing from docket applies here: no docket code, wording, pricing, accounts or repos.
The only thing carried over is Joe's general working style from ~/.claude/CLAUDE.md:
plain UK English, no em dashes or exclamation marks in public copy, and ask Joe before
making any choice that isn't researched.

Never open, read or change any docket folder or account (Railway, Resend, Sentry,
docket's Cloudflare or GitHub). Car Deal Club has its own Resend account and runs in
Jim's Cloudflare account.

## Where things are
- design/2026-11-08 launch/ holds the Claude Design export (cardealclub-launch/). It is
  the design source. Copy screens as drawn; do not redesign.
- www.cardealclub.co.uk is the Cloudflare Pages project car-deal-club in Jim's
  Cloudflare account. Deploy from this folder with Wrangler. Never deploy to production
  until Joe says GO; use a preview branch first.
- KV namespace cdc-signups is bound as SIGNUPS: waiting list keys start waitlist:,
  contact form keys start contact:, older coming-soon sign-ups are plain email keys.
