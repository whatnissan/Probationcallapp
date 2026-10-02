-- 065: Fort Bend recordings for every subscriber, and an honest "expired".
--
-- RUN THIS BEFORE DEPLOYING the code that ships with it: that code writes
-- these columns on the Fort Bend office row every morning, and without them
-- the write fails. Every statement is additive, so running it early is safe
-- under the code already live.
--
-- 1. daily_county_status.recording_duration_seconds. A Fort Bend office row
--    now carries the recording of the call that produced its announcement —
--    URL, duration and transcript written together from ONE call — and each
--    subscriber's row copies it (§4.4). The URL used to be attached before
--    the row existed, so it never landed: on 2026-10-01 recording_url was
--    null on every office row.
--
-- 2. recording_deleted_at on call_history and daily_county_status. Set by the
--    30-day deletion when it clears a recording, so §4.1/§4.2/§4.3's
--    recordingStatus can say "expired" only when a recording really existed
--    and was deleted — never for a row that simply had none. The deletion now
--    also covers office rows, whose audio was never deleted from Twilio.
--
-- 3. Backfill: a row with a stored duration but no URL had a recording that
--    the deletion already removed (duration is written only by the recording
--    webhook, since 2026-08-25). Its deletion time was not recorded, so the
--    marker is set to created_at + 30 days, the deletion's own rule. Rows
--    deleted before durations existed stay null and read as "none".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches rows
-- whose marker is still null.

ALTER TABLE daily_county_status
  ADD COLUMN IF NOT EXISTS recording_duration_seconds integer;
ALTER TABLE daily_county_status
  ADD COLUMN IF NOT EXISTS recording_deleted_at timestamptz;
ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS recording_deleted_at timestamptz;

COMMENT ON COLUMN daily_county_status.recording_duration_seconds IS
  'Duration of the office call whose recording_url and transcript this row carries; written with them by storeFtbendColor (migration 065).';
COMMENT ON COLUMN daily_county_status.recording_deleted_at IS
  'Set by the 30-day recording deletion when it cleared recording_url (migration 065).';
COMMENT ON COLUMN call_history.recording_deleted_at IS
  'Set by the 30-day recording deletion when it cleared recording_url; drives recordingStatus "expired" (migration 065). Backfilled as created_at + 30 days where a duration proves a recording existed.';

UPDATE call_history
SET recording_deleted_at = created_at + interval '30 days'
WHERE recording_url IS NULL
  AND recording_duration_seconds IS NOT NULL
  AND recording_deleted_at IS NULL
  AND created_at < now() - interval '30 days';

INSERT INTO schema_migrations (filename, note)
VALUES ('065_recording_retention_and_ftbend_audio.sql', 'daily_county_status.recording_duration_seconds; recording_deleted_at on call_history + daily_county_status; backfill deleted markers from stored durations')
ON CONFLICT (filename) DO NOTHING;
