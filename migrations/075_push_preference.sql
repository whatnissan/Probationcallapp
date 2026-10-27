-- 075: the Push choice is stored, and two new reasons a text goes out at once.
--
-- 2026-10-28 (Dave's ruling: option A). Until now the app's Push checkbox
-- was accepted and thrown away — push followed whatever devices were
-- registered — so unticking it changed nothing, and the box always reopened
-- unticked. Now it is a stored preference on the schedule.
--
--   user_schedules.notify_push  default TRUE for every existing and new row:
--     nobody's push changes by the migration, and an account with no device
--     yet must not silently never get pushes once it installs the app (Dave).
--     PUT /schedule turns it off only from app builds that load and show it
--     (PUSH_PREF_MIN_BUILD) — older builds always reopened Push unticked.
--
--   push_deliveries.accepted_count  how many devices Apple accepted for the
--     morning's push (results now go to every device seen within 14 days).
--
--   fallback_reason gains:
--     push_off      the person turned Push off: no push, text/email at once
--     stale_device  only devices not seen for 14+ days: a courtesy push, and
--                   the text at once instead of held behind it
--
-- Safe to re-run. Supabase SQL editor, one statement per block, tracking
-- insert last. 075.3 and 075.4 back to back (the check is briefly absent).

-- 075.1
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS notify_push boolean NOT NULL DEFAULT true;

-- 075.2
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS accepted_count integer;

-- 075.3
ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_fallback_reason_check;

-- 075.4
ALTER TABLE push_deliveries
  ADD CONSTRAINT push_deliveries_fallback_reason_check
  CHECK (fallback_reason IS NULL OR fallback_reason IN ('unread', 'send_failed', 'no_device', 'push_off', 'stale_device'));

-- 075.5
INSERT INTO schema_migrations (filename, note)
VALUES ('075_push_preference.sql', 'user_schedules.notify_push (default true); push_deliveries.accepted_count; fallback reasons push_off, stale_device')
ON CONFLICT (filename) DO NOTHING;
