-- 038: carry the recording duration through the retry state.
--
-- Completes the migration-034 work. A morning that exhausts every Montgomery
-- retry gets its one call_history row written by finalFailMorning() from the
-- pending_retries row, not by the webhook's insert path — so those rows still
-- come out with recording_url set and recording_duration_seconds null. That is
-- the same bug in a different place, and these are precisely the mornings
-- someone would want to listen back to: the ones where the system struggled.
--
-- pending_retries is EPHEMERAL — a row exists only between a failed attempt
-- and that morning's resolution, and the table is empty between mornings. So
-- unlike 034 and 036 there is no historical gap to reason about: the column is
-- fully populated from the first morning after this ships. No backfill, and
-- nothing to document as permanently null.
--
-- No grant changes: the table already answers the public anon key with
-- "permission denied for table" (verified), and adding a column does not
-- alter that.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE pending_retries
  ADD COLUMN IF NOT EXISTS last_recording_duration_seconds integer;

COMMENT ON COLUMN pending_retries.last_recording_duration_seconds IS
  'Duration of the recording from the most recent attempt, carried so finalFailMorning() can write it onto the call_history row for a retry-exhausted morning. Sourced from Twilio RecordingDuration, same as call_history.recording_duration_seconds.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('038_pending_retries_duration.sql')
ON CONFLICT (filename) DO NOTHING;
