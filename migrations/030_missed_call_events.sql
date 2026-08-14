-- migrations/030_missed_call_events.sql
--
-- Durable record of the worst failure mode: a scheduled call that never
-- produced anything. checkCallHealth has computed due-vs-ran-vs-missed every
-- 30 minutes since it was written — and thrown the answer away after sending
-- one admin SMS. A morning where the server was down (or Twilio rejected
-- every dial) left zero rows anywhere; the 2026-08-13 reliability audit
-- found this is the one link of the scheduled->called->transcribed->notified
-- chain that data could not prove. This table persists what the health check
-- already computes.
--
-- One row per user per missed day (unique index); the health check upserts
-- with ignoreDuplicates so re-detection every 30 minutes doesn't duplicate.
-- recovered_at is stamped when a later scan sees the user got a result after
-- all (the :45 recovery cron re-fired them) — so "missed and never
-- recovered" is distinguishable from "missed then caught".
--
-- sched_time is display text ("6:10 America/Chicago"), not a timestamp —
-- deliberately, to avoid timezone arithmetic in the write path.
--
-- service_role only per the standing RLS lockdown pattern.

create table if not exists missed_call_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  missed_date date not null,
  sched_time text,
  detected_at timestamptz not null default now(),
  recovered_at timestamptz,
  note text
);

create unique index if not exists missed_call_events_user_date_uniq
  on missed_call_events (user_id, missed_date);

alter table missed_call_events enable row level security;

revoke all on table missed_call_events from anon;
revoke all on table missed_call_events from authenticated;
