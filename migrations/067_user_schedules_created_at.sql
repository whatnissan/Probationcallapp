-- 067: user_schedules.created_at — when a schedule was first created.
--
-- The missed-call recovery (lib/recovery.js, 2026-10-02) must never dial a
-- schedule created at or after its own call time that day: its first call
-- is tomorrow. That needs the creation time, and no code has ever read one —
-- user_schedules predates this directory, so whether the column exists is
-- not recorded anywhere. updated_at (057) cannot stand in: it moves on every
-- save.
--
-- Written to be right either way:
-- - If created_at already exists, ADD COLUMN is a no-op, real values are
--   kept, and only NULLs (if any) are filled.
-- - If it does not, every existing row gets 2025-01-01, meaning "created
--   before this column" — old enough that the recovery rule never treats it
--   as created today. New rows get now() from the default.
--
-- Shipping order does not matter: the code reads created_at and, when it is
-- absent, falls back to the window rule alone (which is what stops the
-- evening dials). Idempotent.

ALTER TABLE user_schedules
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE user_schedules
SET created_at = '2025-01-01T00:00:00Z'
WHERE created_at IS NULL;

ALTER TABLE user_schedules
  ALTER COLUMN created_at SET DEFAULT now();

COMMENT ON COLUMN user_schedules.created_at IS
  'When the schedule row was first inserted. 2025-01-01 = existed before migration 067 recorded it. Read by the missed-call recovery: a schedule created at or after its own call time that day is not dialled until tomorrow.';

INSERT INTO schema_migrations (filename, note)
VALUES ('067_user_schedules_created_at.sql', 'user_schedules.created_at (default now(); pre-existing rows 2025-01-01 when absent) for the missed-call recovery rule')
ON CONFLICT (filename) DO NOTHING;
