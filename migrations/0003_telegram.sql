-- Telegram account link + "mining finished" notifications.
-- Only for databases created before schema.sql had these columns.
-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0003_telegram.sql

ALTER TABLE users ADD COLUMN telegram_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);

ALTER TABLE mining_sessions ADD COLUMN notified_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_mining_notify ON mining_sessions(ends_at) WHERE claimed_at IS NULL AND notified_at IS NULL;
