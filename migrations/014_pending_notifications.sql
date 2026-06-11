-- migrations/014_pending_notifications.sql
-- Durable queue for Fort Bend per-user notifications. Today's color is
-- detected once (~5:05 AM), but each subscriber is notified at THEIR
-- preferred time — which can be hours later. That delay was a bare
-- setTimeout, so a redeploy in the window silently dropped the
-- notification AND its call_history/billing row (audit R2). Now each
-- pending notification is a row here, drained by the per-minute poller,
-- so it survives a restart.
--
-- One row per user/office/day (unique index) so a re-trigger (e.g. the
-- admin populate button after the auto path) can't double-enqueue.
-- Delivery is also idempotent at send time via a call_history existence
-- check, so even a deleted-then-reinserted row can't double-notify.
--
-- service_role only per the day's RLS lockdown pattern. anon and
-- authenticated have no grants. SERVICE_KEY bypasses RLS for server writes.

create table if not exists pending_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  office_id text not null,
  notify_date date not null,
  send_at timestamptz not null,
  lease_until timestamptz,
  is_unknown boolean default false,
  today_colors text[] default '{}',
  today_display text,
  verified_via_finishprobation boolean default false,
  has_phases boolean default false,
  phase1 text,
  phase2 text,
  result text,
  created_at timestamptz default now()
);

create unique index if not exists pending_notifications_user_office_date_uniq
  on pending_notifications (user_id, office_id, notify_date);
create index if not exists pending_notifications_send_at_idx
  on pending_notifications (send_at);

alter table pending_notifications enable row level security;

revoke all on table pending_notifications from anon;
revoke all on table pending_notifications from authenticated;
