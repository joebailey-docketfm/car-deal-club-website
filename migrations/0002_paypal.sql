-- PayPal subscriptions. The site applies this itself on first use (functions/_lib/schema.js),
-- so it does not need running by hand. Kept here so a fresh database can be built from migrations.
--
-- A member who joined through PayPal has paypal_sub set, and paid_until says when their access
-- ends unless PayPal takes another payment. Members John invites by hand keep paid_until NULL.
ALTER TABLE users ADD COLUMN paypal_sub TEXT;
ALTER TABLE users ADD COLUMN paypal_status TEXT;
ALTER TABLE users ADD COLUMN paid_until INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS users_paypal_sub ON users (paypal_sub);

-- A sign-up started on the Join page. id goes to PayPal as the subscription's custom_id, so the
-- webhook can match the payment to the name and email typed on our form. key_hash is the SHA-256
-- of a secret only the joining browser holds, for checking progress.
CREATE TABLE IF NOT EXISTS signups (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, sub_id TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);

-- Webhook events already handled, so a resent event is not applied twice.
CREATE TABLE IF NOT EXISTS paypal_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL);
