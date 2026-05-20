-- migrations/010_pending_retries.sql
-- Pending retry state for morning-aggregated retry-on-unknown.
-- One row per user while an in-progress retry sequence is alive.
-- Created when a scheduled-morning call's first attempt produces a
-- no-result outcome (UNKNOWN / CALL_FAILED / HOTLINE_DOWN). Updated on
-- each subsequent retry's resolution. Deleted when the morning ends —
-- whether by a confirmed result (MUST_TEST / NO_TEST / PIN_EXPIRED), by
-- exhausting all 3 retries, or by hitting the 14:00 local cutoff.
--
-- A separate per-minute cron poller scans next_attempt_at to fire due
-- retries. When the poller fires a call, it sets next_attempt_at =
-- now() + 10 minutes as an in-flight lease. If the container crashes
-- between "poller fired call" and "webhook resolved call," the lease
-- expires and the poller retries the same attempt. Worst case: one
-- duplicate call. Acceptable; never a missed retry.
--
-- UNIQUE on user_id: at most one in-progress sequence per user. Acts as
-- a defensive constraint against leaks. If today's first-failure handler
-- finds a stale row from a prior day, it compares created_at (in the
-- user's TZ) to today's date — stale row is deleted and a fresh one is
-- created for today.

create table if not exists pending_retries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  county text not null,
  target_number text not null,
  pin text,
  notify_number text,
  notify_email text,
  notify_method text,
  attempt_number int not null default 1,
  last_result text,
  last_call_sid text,
  last_transcript text,
  last_recording_url text,
  next_attempt_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists pending_retries_user_id_idx on pending_retries(user_id);
create index if not exists pending_retries_next_attempt_at_idx on pending_retries(next_attempt_at);
