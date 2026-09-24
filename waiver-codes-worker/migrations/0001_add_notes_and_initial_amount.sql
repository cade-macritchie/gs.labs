-- Adds notes (free text, e.g. "admin" to exclude a code from registrant
-- counts) and initial_amount (the original limit a code was created with,
-- separate from amount which decrements as the code is used).
ALTER TABLE waiver_codes ADD COLUMN notes TEXT;
ALTER TABLE waiver_codes ADD COLUMN initial_amount INTEGER NOT NULL DEFAULT 0;

-- Backfill initial_amount for any codes that already exist, since their
-- original limit was never recorded before this migration.
UPDATE waiver_codes SET initial_amount = amount WHERE initial_amount = 0;
