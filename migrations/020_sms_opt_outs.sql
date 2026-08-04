-- migrations/020_sms_opt_outs.sql
-- C2 — inbound STOP / opt-out handling.
--
-- The SMS consent copy promises "Reply STOP to unsubscribe". Twilio honours
-- STOP at the Messaging Service level, so the texts genuinely stop — but the
-- app never learned. It kept calling sendSMS, treated every send as
-- successful, and kept charging a credit per result the user could no longer
-- receive. This table is the app-side record.
--
-- Keyed on PHONE, not user_id, deliberately:
--   * STOP is a property of a handset, not an account. Twilio blocks the
--     number, so anyone reached at it is blocked regardless of which profile
--     it belongs to.
--   * An inbound STOP can arrive from a number with no matching schedule at
--     all (someone who changed their number, or a wrong number). A user_id
--     primary key would have nowhere to put those.
--   * sendSMS only has the destination number in hand, so a phone-keyed
--     lookup is one indexed read rather than a join through user_schedules.
--
-- user_id is the best-effort resolution at the time we recorded it, kept for
-- admin display and for the confirmation email. ON DELETE SET NULL so
-- deleting a profile never resurrects consent.
--
-- Safe to re-run.

create table if not exists sms_opt_outs (
  phone         text primary key,                       -- E.164, e.g. +18775551234
  user_id       uuid references profiles(id) on delete set null,
  opted_out_at  timestamptz not null default now(),
  source        text not null default 'stop_keyword',   -- 'stop_keyword' | 'twilio_21610' | 'admin'
  last_keyword  text
);

create index if not exists sms_opt_outs_user_idx on sms_opt_outs (user_id);

-- Server uses the service key and bypasses RLS; this is defence in depth,
-- matching the pattern used by credit_transactions (migration 002).
alter table sms_opt_outs enable row level security;

drop policy if exists "sms_opt_outs_admin_read" on sms_opt_outs;
create policy "sms_opt_outs_admin_read"
  on sms_opt_outs
  for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
