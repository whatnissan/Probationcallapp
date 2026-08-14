-- migrations/032_call_attempts.sql
--
-- Append-only dial audit. call_history is written at RESULT time, so a call
-- that dies before producing a result — Twilio rejects the create, no
-- callback ever arrives, config lost mid-flight — writes no row at all.
-- That is why CALL_FAILED / HOTLINE_DOWN / NO_CREDITS totalled ZERO rows in
-- 60 days of production data: the table structurally cannot represent most
-- failures. (Considered and rejected: writing call_history at dial time and
-- updating at result time. call_history is user-facing, and retry mornings
-- deliberately collapse many attempts into one row — dial-time rows would
-- change what users see and touch every one of ~8 result-write sites. This
-- audit table gets the same measurement with two fire-and-forget inserts.)
--
-- One row per dial attempt (including each retry), written by initiateCall
-- and ftbendCallOffice:
--   outcome='dialed'        -> Twilio accepted the create; call_sid recorded
--   outcome='create_failed' -> Twilio rejected before a sid existed; error
--                              carries the reason. Previously log-line-only.
-- "Dialed but no result" = a 'dialed' row with no call_history row for the
-- same call_sid. Never read by the call path; reliability metrics only.
--
-- service_role only per the standing RLS lockdown pattern.

create table if not exists call_attempts (
  id uuid primary key default gen_random_uuid(),
  call_id text,
  call_sid text,
  user_id uuid,
  county text,
  office_id text,
  is_scheduled boolean default false,
  retry_count integer default 0,
  outcome text not null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists call_attempts_created_at_idx
  on call_attempts (created_at);
create index if not exists call_attempts_user_created_idx
  on call_attempts (user_id, created_at);

alter table call_attempts enable row level security;

revoke all on table call_attempts from anon;
revoke all on table call_attempts from authenticated;
