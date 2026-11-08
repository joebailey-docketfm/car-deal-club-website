# Car Deal Club website, launch version

Cloudflare Pages site. Public pages work: Home, About, Member benefits, Prizes, FAQs, Contact, Join.
Log in, Ask Jim, member savings and advert checks show "The members' area opens soon".
Join is a waiting list until the PayPal link is ready.

## Deploy
1. Cloudflare dashboard > Workers & Pages > your Car Deal Club Pages project.
2. Upload this whole folder (index.html, favicons and the functions folder) as a new deployment. No build command; output directory is the root.
3. Settings > Functions > KV namespace bindings: bind a KV namespace as SIGNUPS (the coming-soon page's one is fine).
4. Redeploy. Submit the Join form and the Contact form once, and check that two new keys appear in the KV namespace.

## Emails to enquiries@cardealclub.co.uk (optional, recommended)
Without this, sign-ups and enquiries are saved in KV only.
1. Make a free account at resend.com and verify the cardealclub.co.uk domain (it gives you DNS records to add in Cloudflare).
2. Pages project > Settings > Environment variables: add RESEND_API_KEY (encrypted).
3. Optional: MAIL_TO (default enquiries@cardealclub.co.uk), MAIL_FROM (default website@cardealclub.co.uk).
4. Redeploy.

## Read the lists
KV keys start with waitlist: (Join) or contact: (Contact form).
wrangler kv key list --namespace-id <id>

## Later
- PayPal: swap the waiting list on Join for the PayPal subscription link.
- Members' area and Ask Jim need logins and a database before they can go live.
- Footer social icons were removed until there are real profile links.
