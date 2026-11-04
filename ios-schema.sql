-- New, independent D1 database. Never apply this to the Android production DB.
-- Key has no expiry until first /api/ios/claim; then locked to one device for 24h.
CREATE TABLE IF NOT EXISTS ios_keys (
  license_key TEXT PRIMARY KEY,
  voucher_hash TEXT UNIQUE,
  voucher_deadline INTEGER NOT NULL,
  duration_hours INTEGER NOT NULL DEFAULT 24 CHECK (duration_hours = 24),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  device_hash TEXT,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ios_keys_status_expiry ON ios_keys(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_ios_keys_created_at ON ios_keys(created_at);


-- Link4M sessions. Callback transitions are atomic and expire in 20 minutes.
-- IMPORTANT: this records redirect callbacks, not independently attested Link4M completion.
CREATE TABLE IF NOT EXISTS ios_link_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'started' CHECK(stage IN ('started','step1_seen','ready','complete')),
  stage2_hash TEXT,
  completed_at INTEGER,
  license_key TEXT UNIQUE,
  FOREIGN KEY(license_key) REFERENCES ios_keys(license_key)
);
CREATE INDEX IF NOT EXISTS idx_ios_link_sessions_expiry ON ios_link_sessions(expires_at);
