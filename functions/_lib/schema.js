// Brings the database up to date the first time each server instance handles a request.
// The site can change its own database, so new tables arrive with a deploy and nobody has to
// run migrations by hand. Each step is safe to run again. Keep in step with migrations/0002_paypal.sql.
let ready = null;

const STEPS = [
  "CREATE TABLE IF NOT EXISTS signups (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, sub_id TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS paypal_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL)',
];
const COLUMNS = [['paypal_sub', 'TEXT'], ['paypal_status', 'TEXT'], ['paid_until', 'INTEGER']];

async function migrate(env) {
  const { results } = await env.DB.prepare('PRAGMA table_info(users)').all();
  const have = new Set(results.map((c) => c.name));
  for (const [name, type] of COLUMNS) {
    if (have.has(name)) continue;
    try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } // another instance got there first
  }
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_paypal_sub ON users (paypal_sub)').run();
  for (const sql of STEPS) await env.DB.prepare(sql).run();
}

export function ensureSchema(env) {
  if (!ready) ready = migrate(env).catch((e) => { ready = null; throw e; });
  return ready;
}
