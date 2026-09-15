-- 057: START restores the notify method; user_schedules.updated_at tells the truth.
--
-- 1. notify_method_before_optout
--    An inbound STOP (or a Twilio 21610) on a schedule that texts switches
--    notify_method to email so the result still lands. Until now START
--    only cleared the opt-out row: the schedule stayed on email and the
--    STOP email told the user to "turn SMS back on at probationcall.com".
--    This column holds the method the STOP replaced ('sms' or 'both') so
--    START can put it back — and ONLY when nothing moved in between: the
--    method is still 'email', the stored prior is sms/both, and the number
--    that texted START is still the schedule's notify_number. Otherwise the
--    schedule is left alone and the stored value is cleared. Any user-driven
--    write of notify_method (schedule save, the switch-to-email prompt)
--    clears it too, so a deliberate choice of email is never undone by a
--    later START.
--
-- 2. updated_at
--    The column existed with a default of now() and nothing ever wrote it
--    again, so every row reported its INSERT time as its update time
--    (2025-12-17 on the oldest). Two consumers order on it (the
--    notification_log attribution on a shared number, and admin reads), so
--    a stale value was actively misleading. A BEFORE UPDATE trigger
--    maintains it from here on; PostgREST upserts that hit ON CONFLICT are
--    UPDATEs and fire it too. Values from before this migration are the
--    row's insert time and cannot be reconstructed — they are a lower bound,
--    not a lie, once the trigger is in place.
--
-- Safe to re-run. Run in the Supabase SQL editor, tracking insert in the
-- same session.

ALTER TABLE user_schedules
  ADD COLUMN IF NOT EXISTS notify_method_before_optout text;

ALTER TABLE user_schedules
  DROP CONSTRAINT IF EXISTS user_schedules_notify_method_before_optout_check;
ALTER TABLE user_schedules
  ADD CONSTRAINT user_schedules_notify_method_before_optout_check
  CHECK (notify_method_before_optout IS NULL OR notify_method_before_optout IN ('sms', 'both'));

COMMENT ON COLUMN user_schedules.notify_method_before_optout IS
  'notify_method as it was before an inbound STOP / Twilio 21610 switched the schedule to email (''sms'' or ''both''). START restores it if the method is still email and the number still matches, then clears it. Cleared by any user-driven notify_method write. NULL = nothing to restore.';

ALTER TABLE user_schedules
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE user_schedules
  ALTER COLUMN updated_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_schedules_set_updated_at ON user_schedules;
CREATE TRIGGER user_schedules_set_updated_at
  BEFORE UPDATE ON user_schedules
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN user_schedules.updated_at IS
  'Last write to the row, maintained by trigger user_schedules_set_updated_at since migration 057. Rows untouched since then still carry their insert time.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename, note)
VALUES ('057_optout_restore_and_updated_at.sql', 'notify_method_before_optout; updated_at trigger on user_schedules')
ON CONFLICT (filename) DO NOTHING;
