-- migrations/013_pending_calls.sql
-- Durable mirror of the in-memory `pendingCalls` map so an in-flight call
-- survives a process restart / Railway redeploy. The map is still the hot
-- path; this table is read ONLY when the map misses (which, after a
-- restart, is every still-pending call). Without it, a deploy during the
-- 1-5 minutes between twilioClient.calls.create() and the recording
-- webhook orphaned the call: the webhook found no config and returned
-- silently, so the user was never notified and (for Fort Bend attempt 1)
-- nothing retried.
--
-- Rows are short-lived: deleted on the 10-minute cleanup timer and swept
-- hourly (anything older than 1 hour is a dead call). No long-term data.
--
-- service_role only per the day's RLS lockdown pattern. anon and
-- authenticated have no grants. SERVICE_KEY bypasses RLS for server writes.

create table if not exists pending_calls (
  call_id text primary key,
  call_sid text,
  user_id uuid,
  county text,
  is_ftbend_daily boolean default false,
  office_id text,
  has_phases boolean default false,
  is_scheduled_morning boolean default false,
  pin text,
  target_number text,
  notify_number text,
  notify_email text,
  notify_method text,
  retry_count int default 0,
  transcribe_retry int default 0,
  created_at timestamptz default now()
);

create index if not exists pending_calls_created_at_idx
  on pending_calls (created_at);

alter table pending_calls enable row level security;

revoke all on table pending_calls from anon;
revoke all on table pending_calls from authenticated;
