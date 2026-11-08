// Real web push check in Firefox (Mozilla's push service): Jim turns on notifications, sends a test,
// and the service worker must show a decrypted notification.
// Usage: node tests/push.mjs <base url> <jim's password>
import { firefox } from 'playwright';

const [base, password] = process.argv.slice(2);
const browser = await firefox.launch({ firefoxUserPrefs: { 'dom.push.enabled': true, 'dom.push.serverURL': 'wss://push.services.mozilla.com/', 'dom.push.connection.enabled': true, 'permissions.default.desktop-notification': 1 } });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
try {
  await p.goto(base + '/admin/#/admin');
  await p.getByLabel('Email address').fill('james_dean1@sky.com');
  await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Log in' }).click();
  await p.getByRole('heading', { name: 'Member requests' }).waitFor();
  await p.goto(base + '/admin/#/admin-phone');
  await p.getByRole('button', { name: 'Turn on notifications' }).click();
  await p.getByText('Notifications are on for this device.').waitFor({ timeout: 30000 });
  console.log('ok  subscribed');
  await p.getByRole('button', { name: 'Send a test notification' }).click();
  await p.getByText('Test sent.').waitFor({ timeout: 30000 });
  console.log('ok  push service accepted the test');
  let shown = [];
  for (let i = 0; i < 20 && !shown.length; i++) {
    await p.waitForTimeout(1000);
    shown = await p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title + ': ' + n.body));
  }
  if (!shown.length) throw new Error('No notification shown');
  console.log('ok  notification shown: ' + shown[0]);
  console.log('PASS');
} catch (e) {
  console.log('FAIL ' + e.message.split('\n')[0]);
  await p.screenshot({ path: 'test-results/push-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
