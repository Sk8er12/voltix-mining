-- Miner level from the VTX held in the connected wallet (replaces buying upgrades).
-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0006_holding_levels.sql

ALTER TABLE users ADD COLUMN mining_bank_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN held_micro INTEGER;
ALTER TABLE users ADD COLUMN held_checked_at INTEGER;
