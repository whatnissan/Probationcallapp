-- migrations/028_user_schedules_no_credit_skip_count.sql
--
-- RETROACTIVE RECORD. user_schedules.no_credit_skip_count was added by hand
-- in the Supabase SQL editor and never got a migration file — found by the
-- 2026-08-13 migrations-vs-production audit. It backs the zero-credit
-- schedule pause/resume logic alongside paused_reason (migration 017):
-- counts consecutive skipped mornings, reset to 0 when credits land and the
-- schedule auto-resumes (resumePausedScheduleIfAny in server.js).
--
-- Definition transcribed from the live production schema (PostgREST OpenAPI
-- introspection, 2026-08-13): integer, nullable, default 0. Running this
-- against production is a no-op.

alter table user_schedules
  add column if not exists no_credit_skip_count integer default 0;
