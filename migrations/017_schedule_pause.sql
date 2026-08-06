-- migrations/017_schedule_pause.sql
--
-- RECONSTRUCTION. Applied to production 2026-08-03; this file was written
-- 2026-08-06 to close a gap where the change existed in the database but had
-- no record in the repo. The SQL below is verbatim what was run.
-- Verified applied by selecting paused_reason from user_schedules and
-- confirming it resolves as a column defaulting to NULL.
--
-- Pause-instead-of-delete on credit depletion. Two consecutive zero-credit
-- mornings previously DELETED the user_schedules row, destroying the PIN,
-- county, notify method and time. Buying credits afterwards restored nothing
-- and nothing prompted a rebuild, so depletion was effectively account death.
--
-- user_schedules.enabled already existed and loadAllSchedules() already
-- filtered on it, so pausing needed exactly one new column: WHY it is
-- disabled, so the system can tell "the user switched this off" from "we
-- paused this for non-payment" and only auto-resume the latter.
--
--   enabled = true                              -> running
--   enabled = false, paused_reason = NULL       -> user-initiated
--   enabled = false, paused_reason='no_credits' -> system-paused, auto-resumes
--
-- Additive and nullable. No backfill: every existing row was enabled = true,
-- already the correct state. Safe to re-run.

alter table user_schedules
  add column if not exists paused_reason text;

comment on column user_schedules.paused_reason is
  'Why enabled=false. NULL = user-initiated. ''no_credits'' = system-paused on depletion, auto-resumes when credits are granted.';
