CREATE TABLE IF NOT EXISTS ton_proof_challenges (
  payload TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ton_proof_challenges_expiry
  ON ton_proof_challenges (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions (expires_at);
