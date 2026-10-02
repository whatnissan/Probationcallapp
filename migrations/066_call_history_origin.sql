-- 066: call_history.origin — which writer made a row, when it is not the
-- ordinary call/delivery pipeline.
--
-- RUN THIS BEFORE DEPLOYING the code that ships with it: the signup-day
-- writer inserts origin, and the admin user panel selects it. Additive, so
-- running it early is safe under the code already live.
--
-- 'signup_day' (2026-10-02): a Fort Bend schedule created after its office's
-- morning answer was confirmed gets a call_history row for today at once —
-- the office's own confirmed answer against the subscriber's colour, with the
-- office recording and transcript. It is deliberately NOT billed (the office
-- call already happened), so billed_at stays null. Without a marker that row
-- is indistinguishable from a billing failure, and the admin panel's
-- billable_unbilled counter — the tripwire for a repeat of the 015 outage —
-- would count it. NULL means the ordinary pipeline wrote the row.
--
-- Idempotent.

ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS origin text;

COMMENT ON COLUMN call_history.origin IS
  'NULL = written by the call/delivery pipeline. ''signup_day'' = the free first-day Fort Bend answer written when a schedule is created after the office answer was confirmed; billed_at stays null by design (migration 066).';

INSERT INTO schema_migrations (filename, note)
VALUES ('066_call_history_origin.sql', 'call_history.origin; signup_day rows are free by design and excluded from billable_unbilled')
ON CONFLICT (filename) DO NOTHING;
