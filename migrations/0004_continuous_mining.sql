-- 24/7 mining: VOLTIX accrue continuously from users.mining_since.
-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0004_continuous_mining.sql

ALTER TABLE users ADD COLUMN mining_since INTEGER;
ALTER TABLE users ADD COLUMN reminded_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_remind ON users(mining_since) WHERE telegram_id IS NOT NULL;

-- An unclaimed 24h session keeps going: accrual starts from its start time.
UPDATE users SET mining_since = (
  SELECT MIN(started_at) FROM mining_sessions s WHERE s.user_id = users.id AND s.claimed_at IS NULL
);
-- Everyone else who has mined before continues from their last claim.
UPDATE users SET mining_since = (
  SELECT MAX(claimed_at) FROM mining_sessions s WHERE s.user_id = users.id
) WHERE mining_since IS NULL;

-- Close the old sessions; their time is now covered by mining_since.
UPDATE mining_sessions SET claimed_at = CAST(strftime('%s','now') AS INTEGER), notified_at = COALESCE(notified_at, 0)
WHERE claimed_at IS NULL;
