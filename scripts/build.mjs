// Builds public/ from the Claude Design export plus the edited page template in src/template.html.
// The export's index.html carries the assets as a base64 manifest; only its template is swapped.
// public/admin/index.html is the same page with a web app manifest, so Jim can add the admin
// to his phone's home screen and get push notifications.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const design = path.join(root, 'design', '2026-11-08 launch', 'cardealclub-launch');
const out = path.join(root, 'public');

const shell = fs.readFileSync(path.join(design, 'index.html'), 'utf8');
const template = fs.readFileSync(path.join(root, 'src', 'template.html'), 'utf8');

const OPEN = '<script type="__bundler/template">';
const start = shell.indexOf(OPEN);
const end = shell.indexOf('</script>', start);
if (start < 0 || end < 0) throw new Error('No __bundler/template script in the design export');

const encode = (html) => JSON.stringify(html).replace(/<\//g, '<\\u002F');
const page = (html) => shell.slice(0, start + OPEN.length) + '\n' + encode(html) + '\n' + shell.slice(end);

const adminHead = [
  '<link rel="manifest" href="/admin.webmanifest">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="CDC Admin">',
  '<meta name="theme-color" content="#061a33">',
  '<link rel="apple-touch-icon" href="/favicon-180.png">',
].join('\n');
const adminTemplate = template
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '$&\n' + adminHead)
  .replace(/<link rel="apple-touch-icon"[^>]*href="[0-9a-f-]{36}">\n?/, '');
if (adminTemplate === template) throw new Error('Could not add the admin manifest to the template head');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'admin'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), page(template));
fs.writeFileSync(path.join(out, 'admin', 'index.html'), page(adminTemplate));
for (const f of ['favicon-32.png', 'favicon-180.png', 'favicon-512.png']) fs.copyFileSync(path.join(design, f), path.join(out, f));
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(out, f));
console.log('Built', fs.readdirSync(out).join(', '));
