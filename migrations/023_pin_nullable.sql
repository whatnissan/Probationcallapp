-- migrations/023_pin_nullable.sql
-- Fort Bend schedules have no per-user PIN.
--
-- The county announces a colour/phase to everyone; there is nothing to key on
-- per user. The client has always sent pin: '' for Fort Bend, and the Fort
-- Bend hotfix (5ba9427) correctly started storing null instead of an empty
-- string — but user_schedules.pin is NOT NULL, so every Fort Bend "Finish
-- setup" died on the constraint and surfaced the raw Postgres error to the
-- user.
--
-- Making the column nullable is the honest schema: null means "no PIN
-- applies", which is exactly the Fort Bend case. Storing '' instead would be
-- a lie that every reader would then have to special-case.
--
-- Verified safe — no code path reads pin for a Fort Bend row:
--   * rescheduleUser returns early for county='ftbend' (no per-user call)
--   * the :45 recovery cron selects .neq('county','ftbend')
--   * /api/admin/trigger-call/:userId branches on ftbend BEFORE initiateCall
--   * notification bodies that interpolate the PIN are all on the
--     isFtbend === false branch, and the CALL_FAILED message already guards
--     with (config.pin ? ... : '')
--   * the dashboard and admin panel both render it null-safely
--
-- Montgomery is unaffected: /api/schedule still rejects a non-6-digit PIN for
-- any county other than ftbend, so the application-level requirement stands
-- where it actually applies.
--
-- Safe to re-run.

alter table user_schedules alter column pin drop not null;

comment on column user_schedules.pin is
  'Montgomery hotline ID, 6 digits. NULL for Fort Bend, which announces a county-wide colour/phase and has no per-user PIN.';
