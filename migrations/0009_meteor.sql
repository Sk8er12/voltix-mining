-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0009_meteor.sql

-- Meteor Shower game rounds
CREATE TABLE IF NOT EXISTS meteor_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  day          INTEGER UNIQUE,                  -- UTC day of the daily round; NULL = started by an admin
  cancelled    INTEGER NOT NULL DEFAULT 0,
  paid_micro   INTEGER NOT NULL DEFAULT 0,
  budget_micro INTEGER NOT NULL,
  CHECK (paid_micro <= budget_micro)
);
CREATE INDEX IF NOT EXISTS idx_meteor_events_end ON meteor_events(ends_at);

-- One collected meteor (wave = its number in the round), once per player
CREATE TABLE IF NOT EXISTS meteor_hits (
  event_id     INTEGER NOT NULL REFERENCES meteor_events(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  wave         INTEGER NOT NULL,
  amount_micro INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id, wave)
) WITHOUT ROWID;
