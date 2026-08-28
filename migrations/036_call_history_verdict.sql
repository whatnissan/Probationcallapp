-- 036: store the Fort Bend verdict at write time.
--
-- Today call_history.result holds what the hotline ANNOUNCED for the office
-- ("COLOR:Auburn", "P1:Phase 1 P2:Phase 3"), never what it MEANT for the
-- user. So a past MUST_TEST/NO_TEST can only be re-derived by comparing the
-- announcement against the user's CURRENT profiles.user_color — which is
-- wrong the moment anyone's color changes, on what is a compliance record.
--
-- Additive on purpose: `result` keeps its existing format, so the billing
-- regex (/^COLOR:|^P1:/), the dashboard renderer, and the prediction model
-- all keep working untouched. Only new writes populate these columns.
--
-- NO BACKFILL. Historical rows stay null and keep being derived, with the raw
-- announcement shown in the history summary. Inventing verdicts for rows we
-- cannot actually resolve would be the same fabrication this column exists to
-- end — it would just be harder to spot afterwards.
--
-- verdict_color records the color the announcement was matched against AT THE
-- TIME, so the record is self-contained: a later color change can never
-- silently rewrite what we told someone last winter.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS verdict       text,
  ADD COLUMN IF NOT EXISTS verdict_color text;

-- Constrain to the three values this column may ever hold. Existing rows are
-- all NULL, so this validates immediately.
ALTER TABLE call_history
  DROP CONSTRAINT IF EXISTS call_history_verdict_check;
ALTER TABLE call_history
  ADD CONSTRAINT call_history_verdict_check
  CHECK (verdict IS NULL OR verdict IN ('MUST_TEST', 'NO_TEST', 'UNKNOWN'));

COMMENT ON COLUMN call_history.verdict IS
  'What the announcement meant for THIS user, decided at call time. Null for rows written before 2026-08-27 — those are re-derived from the announcement and the user''s current color, which is a best effort, not a record.';
COMMENT ON COLUMN call_history.verdict_color IS
  'The user color the announcement was matched against at call time, so the verdict stays auditable after a color change.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('036_call_history_verdict.sql')
ON CONFLICT (filename) DO NOTHING;
