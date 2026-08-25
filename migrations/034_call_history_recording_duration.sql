-- 034: capture recording length for the v1 recording player.
-- Twilio already posts RecordingDuration to /webhook/recording; we have been
-- discarding it. Nullable integer — historical rows stay null (accepted),
-- populated going forward when the recording webhook fires.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS recording_duration_seconds integer;

COMMENT ON COLUMN call_history.recording_duration_seconds IS
  'Length of the Twilio call recording in seconds, from RecordingDuration on the recording webhook. Null for calls before 2026-08-25 and for rows with no recording.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('034_call_history_recording_duration.sql')
ON CONFLICT (filename) DO NOTHING;
