CREATE TABLE IF NOT EXISTS waiver_codes (
  code TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0,
  initial_amount INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
