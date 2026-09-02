-- 041: the SMS a push fallback should send, stored with the delivery.
--
-- Migration 039 gave the fallback sweep a result ('MUST_TEST' / 'NO_TEST') and
-- let the sweep compose the text itself. That text was written for Montgomery
-- ("Your PIN was called"). Fort Bend now pushes too, and a Fort Bend user who
-- never opened their push would have been texted about a PIN they do not
-- have — Montgomery wording sent to a Fort Bend subscriber is worse than a
-- generic message, because it reads as somebody else's result.
--
-- So the caller that decides the push now also records the EXACT message it
-- would have sent had push not existed, and the sweep sends that verbatim.
-- The sweep keeps its generic composition only for rows that predate this
-- column (NULL here), so nothing already queued changes behaviour.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS fallback_message text;

COMMENT ON COLUMN push_deliveries.fallback_message IS
  'The SMS/email text to send if the push is not acknowledged — the same message the caller would have sent directly. NULL only on rows created before migration 041; the sweep then composes a generic message from result.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('041_push_fallback_message.sql')
ON CONFLICT (filename) DO NOTHING;
