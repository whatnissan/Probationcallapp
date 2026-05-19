-- Migration: consecutive PIN_EXPIRED counter on user_schedules.
-- Additive: adds one nullable column with default 0. Existing rows behave
-- as if no streak in progress.
--
-- Server tracks how many consecutive PIN_EXPIRED results a user has had.
-- After 2 in a row, the schedule is auto-disabled and the user is alerted
-- that their PIN appears expired. The counter resets on:
--   - Any successful MUST_TEST / NO_TEST result (cleared in deductCreditOnce)
--   - The user saving their schedule again via /api/schedule (e.g. with a
--     new PIN)
-- Schedule.enabled also auto-flips back to true on /api/schedule save.

alter table user_schedules
  add column if not exists consecutive_pin_expired integer default 0;
