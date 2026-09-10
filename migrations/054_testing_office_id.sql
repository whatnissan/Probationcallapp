-- 054: the office the county assigned a Montgomery user to (contract §3 / §4.7).
--
-- The USER declares this; the app never picks an office for anyone. NULL is
-- a legitimate state — "has not told us" — and every consumer renders it as
-- today's all-offices behaviour. No consumer may default to an office.
--
-- Montgomery only. Fort Bend rows stay NULL: ftbendOffice is a hotline
-- line, this is a building, and Fort Bend has no verified buildings yet.
--
-- Deliberately NO foreign key to offices(id). Retiring an office (049 keeps
-- the row, flips is_active) must not cascade into anyone's schedule, and a
-- plain FK would block retiring an office anyone is assigned to. Instead
-- the server validates against ACTIVE offices at write time, and nulls a
-- retired id on read, so restoring the office restores the assignment.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE user_schedules
  ADD COLUMN IF NOT EXISTS testing_office_id text;

COMMENT ON COLUMN user_schedules.testing_office_id IS
  'offices.id the county assigned this user to (contract §3 testingOfficeId). User-declared, Montgomery only. NULL = not told us; consumers render all offices. No FK on purpose: retired ids are nulled on read, never cascaded.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('054_testing_office_id.sql')
ON CONFLICT (filename) DO NOTHING;
