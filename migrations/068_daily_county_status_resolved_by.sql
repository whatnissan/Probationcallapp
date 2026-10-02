-- 068: daily_county_status.resolved_by — how a Fort Bend office's answer was
-- reached: 'call' (our own call confirmed it) or 'finishprobation' (taken
-- from finishprobation.com after our calls could not).
--
-- RUN THIS BEFORE DEPLOYING the code that ships with it: every office row
-- write now includes resolved_by, and fails without the column — which would
-- lose that morning's office row. Additive, so running it early is safe.
--
-- Why a column: the 10:00 AM recording check must know whether an office
-- row SHOULD have audio. The only marker until now was the audio itself
-- (only the confirmed path writes one, d30f813), which would make "every
-- call-resolved office has a recording" true by definition. Each of the four
-- places that store an office's answer now declares this explicitly, so a
-- confirmed call whose recording failed to land shows up as resolved_by
-- 'call' with no recording_url. The populate path (pre-cutoff safety net and
-- the admin button) leaves no other record of how it resolved.
--
-- Backfill: rows that already carry a recording were resolved by our call —
-- nothing else writes one. Other existing rows stay NULL (not recorded).
--
-- Idempotent.

ALTER TABLE daily_county_status
  ADD COLUMN IF NOT EXISTS resolved_by text;

ALTER TABLE daily_county_status
  DROP CONSTRAINT IF EXISTS daily_county_status_resolved_by_check;

ALTER TABLE daily_county_status
  ADD CONSTRAINT daily_county_status_resolved_by_check
  CHECK (resolved_by IS NULL OR resolved_by IN ('call', 'finishprobation'));

UPDATE daily_county_status
SET resolved_by = 'call'
WHERE resolved_by IS NULL
  AND recording_url IS NOT NULL
  AND county LIKE 'ftbend_%';

COMMENT ON COLUMN daily_county_status.resolved_by IS
  '''call'' = our own call confirmed this announcement (the row carries its recording); ''finishprobation'' = taken from finishprobation.com after our calls could not (no recording, by design). NULL = written before migration 068.';

INSERT INTO schema_migrations (filename, note)
VALUES ('068_daily_county_status_resolved_by.sql', 'daily_county_status.resolved_by (call | finishprobation) for the 10:00 AM Fort Bend recording check; backfilled call where a recording exists')
ON CONFLICT (filename) DO NOTHING;
