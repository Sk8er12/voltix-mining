-- Upgrades, daily check-in, tasks, leaderboard.
-- Only for databases created before schema.sql had these columns.
-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0002_game_features.sql

ALTER TABLE users ADD COLUMN miner_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_checkin_day INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance_micro DESC);

CREATE TABLE IF NOT EXISTS user_tasks (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  task_id    TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);
