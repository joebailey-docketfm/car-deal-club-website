// End-to-end check of the members' area loop, at phone and desktop sizes.
// Usage: node tests/loop.mjs <base url> <admin set-password link or "login:<password>"> <member email> [shots dir]
// Jim invites a member, the member sets a password, logs in and sends a request,
// Jim reads it, marks it as on it and replies, and the member sees the answer.
import { chromium } from 'playwright';
import fs from 'node:fs';

const [base, adminLink, memberEmail, shots = 'test-results'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const PW_ADMIN = 'jim-test-password-1', PW_MEMBER = 'member-test-password-1';
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const browser = await chromium.launch();
const step = (msg) => console.log('ok  ' + msg);
const shot = (page, name) => page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
const errors = [];
const watch = (page, who) => page.on('pageerror', (e) => errors.push(who + ': ' + e.message));

try {
  // Jim sets his password from the admin link, or logs in.
  const jim = await browser.newContext(DESKTOP);
  const a = await jim.newPage(); watch(a, 'jim');
  if (adminLink.startsWith('login:')) {
    await a.goto(base + '/admin/#/admin');
    await a.getByLabel('Email address').fill('james_dean1@sky.com');
    await a.getByLabel('Password').fill(adminLink.slice(6));
    await a.getByRole('button', { name: 'Log in' }).click();
  } else {
    await a.goto(adminLink);
    await a.getByText('Set your password').waitFor();
    await shot(a, 'desktop-admin-set-password');
    await a.getByLabel('New password').fill(PW_ADMIN);
    await a.getByLabel('Type it again').fill(PW_ADMIN);
    await a.getByRole('button', { name: 'Save password and log in' }).click();
  }
  await a.getByRole('heading', { name: 'Member requests' }).waitFor();
  step('Jim is in the admin');

  // Jim invites the member.
  await a.goto(base + '/admin/#/admin-members');
  await a.getByText('Invite a member').waitFor();
  await a.getByLabel('Name').fill('Sam Tester');
  await a.getByLabel('Email address').fill(memberEmail);
  await a.getByRole('button', { name: 'Send invite' }).click();
  const linkBox = a.locator('span', { hasText: '/#/set-password/' }).last();
  const sentBox = a.getByText('Invite sent to ' + memberEmail);
  await Promise.race([linkBox.waitFor(), sentBox.waitFor()]);
  let invite = (await linkBox.count()) ? (await linkBox.textContent()).trim() : null;
  await a.getByText('Sam Tester').first().waitFor();
  await shot(a, 'desktop-admin-members');
  step('Jim invited the member' + (invite ? ' (link shown)' : ' (email sent)'));
  if (!invite) {
    // Email went out, so fetch a fresh link through a second invite that we can't read. Use the API instead.
    const r = await a.evaluate(async (email) => (await fetch('/api/admin/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sam Tester', email }) })).json(), memberEmail);
    if (!r.link) throw new Error('Invite was emailed, so the test cannot read the link. Use a member email outside EMAIL_ALLOW.');
    invite = r.link;
  }

  // The member sets a password on a phone and lands on Ask Jim.
  const mem = await browser.newContext(PHONE);
  const m = await mem.newPage(); watch(m, 'member');
  await m.goto(invite);
  await m.getByText('Hello Sam').waitFor();
  await shot(m, 'phone-member-set-password');
  await m.getByLabel('New password').fill(PW_MEMBER);
  await m.getByLabel('Type it again').fill(PW_MEMBER);
  await m.getByRole('button', { name: 'Save password and log in' }).click();
  await m.getByText('New request for Jim').waitFor();
  step('Member set a password and landed on Ask Jim');

  // Log out and back in through the member login.
  await m.getByRole('button', { name: 'Log out' }).first().click();
  await m.waitForURL(/#\/home$/);
  await m.goto(base + '/#/login');
  await m.getByRole('heading', { name: 'Member login' }).waitFor();
  await m.getByLabel('Email address').fill(memberEmail);
  await m.getByLabel('Password').fill('wrong-password');
  await m.getByRole('button', { name: 'Log in' }).click();
  await m.getByText('That email and password don’t match.').waitFor();
  await m.getByLabel('Password').fill(PW_MEMBER);
  await m.getByRole('button', { name: 'Log in' }).click();
  await m.getByText('New request for Jim').waitFor();
  await shot(m, 'phone-member-ask-jim-new');
  const session = (await mem.cookies()).find((c) => c.name === 'cdc_session');
  if (!session || session.expires !== -1) throw new Error('Unticked Remember me should give a browser-session cookie');
  step('Member logged in (wrong password refused first), cookie ends with the browser');

  // Remember me ticked: the login lasts 30 days.
  const rem = await browser.newContext(DESKTOP);
  const rp = await rem.newPage(); watch(rp, 'remember');
  await rp.goto(base + '/#/login');
  await rp.getByLabel('Email address').fill(memberEmail);
  await rp.getByLabel('Password').fill(PW_MEMBER);
  await rp.getByLabel('Remember me').check();
  await shot(rp, 'desktop-member-login');
  const deskSize = await rp.getByLabel('Email address').evaluate((el) => getComputedStyle(el).fontSize);
  if (deskSize !== '15px') throw new Error('Desktop login box should stay 15px as drawn, got ' + deskSize);
  await rp.getByRole('button', { name: 'Log in' }).click();
  await rp.getByText('New request for Jim').waitFor();
  const kept = (await rem.cookies()).find((c) => c.name === 'cdc_session');
  const days = kept ? (kept.expires * 1000 - Date.now()) / 86400000 : 0;
  if (days < 29 || days > 31) throw new Error('Ticked Remember me should last 30 days, got ' + days.toFixed(1));
  await rem.close();
  step('Remember me ticked keeps the login 30 days; desktop input text stays ' + deskSize);

  // Other member pages still say they open soon.
  await m.goto(base + '/#/dashboard');
  await m.getByText('This page opens soon').waitFor();
  await m.goto(base + '/#/ask-jim');
  step('Dashboard still shows opens soon');

  // Member sends a request.
  await m.getByText('New request for Jim').waitFor();
  await m.getByLabel('Your question').fill('Where is my cheapest set of tyres? I need four for my Golf.');
  await m.getByLabel('Your car (optional)').fill('2019 VW Golf, 225/45 R17');
  await m.getByLabel('Your area (optional)').fill('ST4');
  await m.getByRole('button', { name: 'Send to Jim' }).click();
  await m.getByText('Sent to Jim').first().waitFor();
  await shot(m, 'phone-member-thread-sent');
  step('Member sent a request, status Sent to Jim');

  // Jim sees it, marks it as on it, and replies.
  await a.goto(base + '/admin/#/admin');
  await a.getByRole('button', { name: /I need four/ }).first().click();
  await a.getByRole('button', { name: 'Mark as on it' }).click();
  await a.getByText('I am on it').first().waitFor();
  step('Jim marked it as on it');
  await m.reload();
  await m.getByRole('button', { name: /I need four/ }).first().click();
  await m.getByText('Jim is on it').first().waitFor();
  step('Member sees Jim is on it');

  await a.getByPlaceholder('Reply to the member').fill('I contacted four fitters near ST4. The best price was £392 for four mid-range tyres, fitted and balanced.');
  await a.getByRole('button', { name: 'Send reply' }).click();
  await a.getByText('Answered').first().waitFor();
  await shot(a, 'desktop-admin-requests');
  step('Jim replied and marked it answered');

  await m.reload();
  await m.getByRole('button', { name: /I need four/ }).first().click();
  await m.getByText('The best price was £392').waitFor();
  await m.getByText('Answer ready').first().waitFor();
  await shot(m, 'phone-member-thread-answered');
  step('Member sees the answer, status Answer ready');

  // Member replies; it goes back to Jim is on it.
  await m.getByPlaceholder('Reply to Jim').fill('Thanks Jim, Saturday morning suits me.');
  await m.getByRole('button', { name: 'Send', exact: true }).click();
  await m.getByText('Saturday morning suits me').waitFor();
  await m.getByText('Jim is on it').first().waitFor();
  step('Member replied, status back to Jim is on it');

  // The same pages at the other size.
  const memDesk = await browser.newContext({ ...DESKTOP, storageState: await mem.storageState() });
  const md = await memDesk.newPage(); watch(md, 'member-desktop');
  await md.goto(base + '/#/ask-jim');
  await md.getByRole('button', { name: /I need four/ }).first().click();
  await md.getByText('Saturday morning suits me').waitFor();
  await shot(md, 'desktop-member-thread');
  const jimPhone = await browser.newContext({ ...PHONE, storageState: await jim.storageState() });
  const ap = await jimPhone.newPage(); watch(ap, 'jim-phone');
  await ap.goto(base + '/admin/#/admin');
  await ap.getByRole('button', { name: /I need four/ }).first().click();
  await ap.getByText('Saturday morning suits me').waitFor();
  await shot(ap, 'phone-admin-requests');
  await ap.goto(base + '/admin/#/admin-members');
  await ap.getByText('Sam Tester').first().waitFor();
  await shot(ap, 'phone-admin-members');
  await ap.goto(base + '/admin/#/admin-phone');
  await ap.getByText('Get notifications on your phone').waitFor();
  await shot(ap, 'phone-admin-notifications');
  await a.goto(base + '/admin/#/admin-phone');
  await a.getByText('This device').waitFor();
  await shot(a, 'desktop-admin-notifications');
  const guest = await browser.newContext(PHONE);
  const g = await guest.newPage(); watch(g, 'guest');
  await g.goto(base + '/#/login');
  await g.getByRole('heading', { name: 'Member login' }).waitFor();
  await shot(g, 'phone-guest-login');
  const phoneSizes = await g.$$eval('input:not([type=checkbox]), textarea, select', (els) => els.map((el) => getComputedStyle(el).fontSize));
  if (!phoneSizes.length || phoneSizes.some((s) => s !== '16px')) throw new Error('Phone inputs should be 16px, got ' + phoneSizes.join(','));
  await ap.goto(base + '/admin/#/admin-members');
  const adminPhoneSizes = await ap.$$eval('input:not([type=checkbox]), textarea', (els) => els.map((el) => getComputedStyle(el).fontSize));
  if (adminPhoneSizes.some((s) => s !== '16px')) throw new Error('Admin phone inputs should be 16px, got ' + adminPhoneSizes.join(','));
  await g.goto(base + '/#/forgot');
  await g.getByLabel('Email address').fill(memberEmail);
  await g.getByRole('button', { name: 'Send me a link' }).click();
  await g.getByText('we have emailed a link').waitFor();
  await shot(g, 'phone-guest-forgot');
  await g.goto(base + '/#/admin');
  await g.getByText('Admin login').first().waitFor();
  await shot(g, 'phone-admin-login');
  step('Screens captured at both sizes');

  if (errors.length) throw new Error('Page errors:\n' + errors.join('\n'));
  console.log('PASS');
} catch (e) {
  console.log('FAIL ' + e.message);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: `${shots}/fail-${Date.now()}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
