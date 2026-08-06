-- migrations/025_notify_number_nullable.sql
--
-- RECONSTRUCTION. Applied to production on or before 2026-08-05; this file
-- was written 2026-08-06. The SQL below is verbatim what was run.
-- Verified applied by attempting an insert with notify_number = NULL against
-- a non-existent user_id: the error code moved from 23502 (not-null
-- violation) to 23503 (foreign key), proving the not-null check now passes
-- and nothing is written.
--
-- Second instance of the same defect as 023. notify_number was NOT NULL, but
-- /api/schedule treats the phone as optional and correctly stores NULL for a
-- user who chose email-only notifications. Every email-only signup therefore
-- died on the constraint and showed the raw Postgres error at "Finish setup" —
-- the same failure Fort Bend hit on the pin column.
--
-- No live row was affected: all schedules had a phone at the time. The
-- application-level rule still stands where it matters — /api/schedule rejects
-- notify_method 'sms' or 'both' without a valid E.164 number, so a user can
-- only reach NULL here by choosing email-only, which is exactly the case NULL
-- should represent.
--
-- Safe to re-run.

alter table user_schedules alter column notify_number drop not null;

comment on column user_schedules.notify_number is
  'E.164 destination for SMS. NULL when notify_method is email-only.';
