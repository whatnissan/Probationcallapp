-- migrations/021_mass_sends.sql
-- Records for admin mass sends (email, text, or both).
--
-- Two tables rather than one row with a JSON recipient blob, because the
-- question you actually ask later is "did THIS user get THAT message" — and
-- because per-recipient failure is the thing worth seeing when Brevo or
-- Twilio rejects one address out of sixteen. A blob cannot answer either
-- without scanning.
--
-- Safe to re-run.

create table if not exists mass_sends (
  id              bigserial primary key,
  channel         text not null,              -- 'email' | 'text' | 'both'
  segment         text not null,              -- 'all' | 'active_schedule' | 'never_configured'
  subject         text,                       -- email only; null for text-only sends
  body            text not null,              -- as composed by the admin, pre-formatting
  sms_body        text,                       -- exactly what handsets received
  sent_by         text not null,              -- admin email
  email_intended  integer not null default 0,
  email_sent      integer not null default 0,
  sms_intended    integer not null default 0,
  sms_sent        integer not null default 0,
  created_at      timestamptz not null default now()
);

create table if not exists mass_send_recipients (
  id            bigserial primary key,
  mass_send_id  bigint not null references mass_sends(id) on delete cascade,
  user_id       uuid references profiles(id) on delete set null,
  channel       text not null,                -- 'email' | 'sms' — one row per channel per person
  destination   text,                         -- email address or E.164, snapshotted at send time
  status        text not null,                -- 'sent' | 'failed' | 'skipped'
  error         text,
  sent_at       timestamptz not null default now()
);

create index if not exists mass_send_recipients_send_idx on mass_send_recipients (mass_send_id);
create index if not exists mass_send_recipients_user_idx on mass_send_recipients (user_id, sent_at desc);

-- Server uses the service key and bypasses RLS; defence in depth, matching
-- credit_transactions (migration 002) and sms_opt_outs (020).
alter table mass_sends enable row level security;
alter table mass_send_recipients enable row level security;

drop policy if exists "mass_sends_admin_read" on mass_sends;
create policy "mass_sends_admin_read" on mass_sends for select
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "mass_send_recipients_admin_read" on mass_send_recipients;
create policy "mass_send_recipients_admin_read" on mass_send_recipients for select
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.is_admin = true));
