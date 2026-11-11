-- VOLTIX Mining — D1 schema.
-- Apply:  npx wrangler d1 execute voltix-db --remote --file=schema.sql
-- Safe to run again: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT    NOT NULL UNIQUE,     -- raw form, e.g. 0:abc...
  balance_micro  INTEGER NOT NULL DEFAULT 0,  -- 1 VOLTIX = 1 000 000 micro
  created_at     INTEGER NOT NULL,
  miner_level      INTEGER NOT NULL DEFAULT 1,
  streak           INTEGER NOT NULL DEFAULT 0,
  last_checkin_day INTEGER,                   -- UTC day number of the last check-in
  telegram_id      INTEGER,                   -- linked Telegram user (notifications)
  mining_since     INTEGER,                   -- continuous mining: accrues from here (last claim)
  reminded_at      INTEGER                    -- last "come collect" Telegram reminder
);
CREATE INDEX IF NOT EXISTS idx_users_remind ON users(mining_since) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance_micro DESC);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);

-- Claimed one-time tasks
CREATE TABLE IF NOT EXISTS user_tasks (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  task_id    TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

-- Legacy 24h sessions (before 24/7 mining); no longer written.
CREATE TABLE IF NOT EXISTS mining_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  started_at   INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  reward_micro INTEGER NOT NULL,
  claimed_at   INTEGER,
  notified_at  INTEGER                        -- "mining finished" message sent
);
CREATE INDEX IF NOT EXISTS idx_mining_notify ON mining_sessions(ends_at) WHERE claimed_at IS NULL AND notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mining_user ON mining_sessions(user_id, claimed_at);

CREATE TABLE IF NOT EXISTS referrals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  amount_micro INTEGER NOT NULL,
  type         TEXT    NOT NULL,              -- mining_reward | referral_bonus
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, id);

-- Withdrawal requests (paid out manually by an admin)
CREATE TABLE IF NOT EXISTS withdrawals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  amount_micro   INTEGER NOT NULL,              -- taken from the balance
  fee_micro      INTEGER NOT NULL,              -- 5% fee
  net_micro      INTEGER NOT NULL,              -- sent to the wallet
  wallet_address TEXT    NOT NULL,              -- raw payout address
  status         TEXT    NOT NULL,              -- pending | paid | rejected
  created_at     INTEGER NOT NULL,
  processed_at   INTEGER,
  tx_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_pending ON withdrawals(user_id) WHERE status = 'pending';

-- One-time ton_proof challenges
CREATE TABLE IF NOT EXISTS login_payloads (
  payload    TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Login sessions (only the SHA-256 of the token is stored)
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
