CREATE TABLE IF NOT EXISTS waiver_codes (
  code TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
