-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0007_purchases.sql

-- VTX sales for TON: one row per order (and per extra payment sent with the same comment)
CREATE TABLE IF NOT EXISTS purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  wallet_address TEXT    NOT NULL,              -- raw address the VTX are sent to
  memo           TEXT    NOT NULL UNIQUE,       -- comment that identifies the payment
  rate           INTEGER NOT NULL,              -- VTX per 1 TON, fixed when ordered
  ton_nano       INTEGER NOT NULL,              -- ordered, then the amount really received
  vtx_units      INTEGER NOT NULL,              -- 6 decimals
  status         TEXT    NOT NULL,              -- awaiting | paid | delivered
  created_at     INTEGER NOT NULL,
  paid_at        INTEGER,
  ton_tx_hash    TEXT    UNIQUE,
  delivered_at   INTEGER,
  tx_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id, id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status, created_at);
