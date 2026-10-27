-- 074: when a schedule was paused, and every pause and resume since.
--
-- 2026-10-27: pausing did not stop calls (fixed in the code shipped with
-- this). Measuring who was hit was guesswork, because nothing recorded WHEN
-- a schedule was paused: updated_at moves on any write, and a pause that was
-- later resumed left no trace at all. This makes it recorded from now on.
--
-- A TRIGGER, not application code, so every writer is covered — the app's
-- pause, STOP, the streak / expired-PIN / no-credits pauses, resumes, the
-- admin panel, a hand-written SQL update, and any path added later:
--   * enabled turns false  -> user_schedules.paused_at = now(), and a
--                             schedule_pause_events row opens (with the reason)
--   * enabled turns true   -> paused_at = NULL, the open event gets resumed_at
--   * reason changes while still paused -> the open event's reason follows
--
-- Pauses that began BEFORE this migration have paused_at NULL and no event:
-- their start is unknown, and a guessed date would be worse than none.
--
-- schedule_pause_events rows go with the account (ON DELETE CASCADE), like
-- the schedule itself. RLS on, no policies: the server reads it.
--
-- Safe to re-run. Supabase SQL editor, one statement per block, tracking
-- insert last.

-- 074.1
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- 074.2
CREATE TABLE IF NOT EXISTS schedule_pause_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason      text,
  paused_at   timestamptz NOT NULL DEFAULT now(),
  resumed_at  timestamptz
);

-- 074.3
CREATE INDEX IF NOT EXISTS schedule_pause_events_user_idx
  ON schedule_pause_events (user_id, paused_at);

-- 074.4
ALTER TABLE schedule_pause_events ENABLE ROW LEVEL SECURITY;

-- 074.5
CREATE OR REPLACE FUNCTION user_schedules_track_pause()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.enabled = false THEN
      NEW.paused_at := now();
      INSERT INTO schedule_pause_events (user_id, reason, paused_at) VALUES (NEW.user_id, NEW.paused_reason, NEW.paused_at);
    ELSE
      NEW.paused_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.enabled = false AND OLD.enabled IS DISTINCT FROM false THEN
    NEW.paused_at := now();
    INSERT INTO schedule_pause_events (user_id, reason, paused_at) VALUES (NEW.user_id, NEW.paused_reason, NEW.paused_at);
  ELSIF NEW.enabled IS DISTINCT FROM false AND OLD.enabled = false THEN
    NEW.paused_at := NULL;
    UPDATE schedule_pause_events SET resumed_at = now() WHERE user_id = NEW.user_id AND resumed_at IS NULL;
  ELSIF NEW.enabled = false AND OLD.enabled = false THEN
    NEW.paused_at := OLD.paused_at;
    IF NEW.paused_reason IS DISTINCT FROM OLD.paused_reason THEN
      UPDATE schedule_pause_events SET reason = NEW.paused_reason WHERE user_id = NEW.user_id AND resumed_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 074.6
DROP TRIGGER IF EXISTS user_schedules_track_pause ON user_schedules;

-- 074.7
CREATE TRIGGER user_schedules_track_pause
  BEFORE INSERT OR UPDATE ON user_schedules
  FOR EACH ROW EXECUTE FUNCTION user_schedules_track_pause();

-- 074.8
INSERT INTO schema_migrations (filename, note)
VALUES ('074_schedule_pause_tracking.sql', 'user_schedules.paused_at + schedule_pause_events, maintained by trigger on every writer')
ON CONFLICT (filename) DO NOTHING;
