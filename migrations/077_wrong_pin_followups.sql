-- 077: WRONG_PIN follow-ups (Dave's review, 2026-10-28).
--
--   user_schedules.last_wrong_pin_day, last_pin_expired_day  the local day
--     of the last WRONG_PIN / PIN_EXPIRED morning. "Two mornings in a row"
--     now means consecutive days for both PIN counts: a count goes up only
--     when the previous one was yesterday, and starts over at 1 otherwise
--     (lib/time.js nextConsecutiveDayCount). Until this, an UNKNOWN or
--     skipped day in between did not break either count, so two failures
--     three weeks apart paused.
--
--   admin_alert_days  one row per once-a-day admin alert actually sent. The
--     primary key makes "already sent today" an atomic claim that survives a
--     restart; the limit was an in-memory date, so a deploy mid-fault sent
--     the alert again. RLS on, no policies: the server writes it.
--
--   user_schedules_track_pause (074's trigger function), replaced: a NEW
--     schedule row first closes any pause event still open for that user.
--     Deleting a schedule never closed its pause, so an account that deleted
--     a paused schedule and saved a new one kept an "open" pause forever
--     behind a running schedule. Once the new row exists the old pause is
--     over either way — re-opened by the insert if the schedule is still
--     paused, ended if not. (A re-created schedule on a rejected PIN comes
--     back paused from server.js priorPinPauseOf, which reads the last PIN
--     pause open or closed; this only keeps the history honest.) Everything
--     else is unchanged from 074.
--
-- Safe to re-run. Supabase SQL editor, one statement per block, tracking
-- insert last.

-- 077.1
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS last_wrong_pin_day date;

-- 077.2
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS last_pin_expired_day date;

-- 077.3
CREATE TABLE IF NOT EXISTS admin_alert_days (
  alert    text NOT NULL,
  day      date NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert, day)
);

-- 077.4
ALTER TABLE admin_alert_days ENABLE ROW LEVEL SECURITY;

-- 077.5
CREATE OR REPLACE FUNCTION user_schedules_track_pause()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE schedule_pause_events SET resumed_at = now() WHERE user_id = NEW.user_id AND resumed_at IS NULL;
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

-- 077.6
INSERT INTO schema_migrations (filename, note)
VALUES ('077_wrong_pin_followups.sql', 'user_schedules.last_wrong_pin_day + last_pin_expired_day (consecutive days); admin_alert_days (persisted once-a-day alerts); pause trigger closes a deleted schedule''s open pause on insert')
ON CONFLICT (filename) DO NOTHING;
