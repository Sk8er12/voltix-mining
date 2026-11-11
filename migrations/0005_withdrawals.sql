-- Withdrawal requests (Wallet tab).
-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0005_withdrawals.sql

CREATE TABLE IF NOT EXISTS withdrawals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  amount_micro   INTEGER NOT NULL,
  fee_micro      INTEGER NOT NULL,
  net_micro      INTEGER NOT NULL,
  wallet_address TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  processed_at   INTEGER,
  tx_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_pending ON withdrawals(user_id) WHERE status = 'pending';
