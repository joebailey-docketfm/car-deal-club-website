// Creates Jim's admin account (if missing) and prints a set-your-password link for it.
// Usage: node scripts/invite-admin.mjs <local|preview|production> <site origin> [email] [name]
// Example: node scripts/invite-admin.mjs production https://www.cardealclub.co.uk
import { execFileSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [target, origin, emailArg, nameArg] = process.argv.slice(2);
const DB = { local: 'cdc-members-preview', preview: 'cdc-members-preview', production: 'cdc-members' }[target];
if (!DB || !/^https?:\/\//.test(origin || '')) {
  console.error('Usage: node scripts/invite-admin.mjs <local|preview|production> <site origin>');
  process.exit(1);
}
// Jim by default. Tests pass a separate test admin so they never touch Jim's account.
const email = (emailArg || 'james_dean1@sky.com').toLowerCase();
const name = nameArg || (emailArg ? 'Test Admin' : 'Jim');
if (!/^[^\s@']+@[^\s@']+$/.test(email) || /'/.test(name)) throw new Error('Bad email or name');
const b64url = (b) => Buffer.from(b).toString('base64url');
const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
const id = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
const now = Date.now();

const sql = [
  `INSERT INTO users (email, name, role, created_at) VALUES ('${email}', '${name}', 'admin', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'admin';`,
  `UPDATE tokens SET used_at = ${now} WHERE used_at IS NULL AND user_id = (SELECT id FROM users WHERE email = '${email}');`,
  `INSERT INTO tokens (id, user_id, kind, expires_at) SELECT '${id}', id, 'invite', ${now + 7 * 86400000} FROM users WHERE email = '${email}';`,
].join(' ');

const file = path.join(os.tmpdir(), 'cdc-invite-admin.sql');
fs.writeFileSync(file, sql);
const args = ['wrangler', 'd1', 'execute', DB, target === 'local' ? '--local' : '--remote', '--file', JSON.stringify(file), '--yes'];
if (target !== 'production') args.push('--env', 'preview'); else args.push('--env', 'production');
execFileSync('npx', args, { stdio: ['ignore', 'ignore', 'inherit'], shell: true });
fs.rmSync(file);
console.log(`${origin}/admin/#/set-password/${token}`);
