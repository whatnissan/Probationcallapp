-- migrations/024_outage_events.sql
--
-- RECONSTRUCTION. Applied to production 2026-08-05; this file was written
-- 2026-08-06. The SQL below is verbatim what was run.
-- Verified applied by selecting all eleven columns from outage_events and
-- confirming the table resolves and returns rows (0 at the time).
--
-- Durable record of a declared outage. A table rather than in-memory state,
-- for two reasons learned the hard way here:
--   * checkCallHealth throttles on a module-level boolean, so a redeploy
--     re-arms it and can re-alert the same day (same class of bug as the H9
--     stale closure)
--   * the all-clear has to know an outage was declared YESTERDAY, which
--     cannot survive in memory at all
--
-- NOTE: the outage detection feature this table supports is DESIGNED but NOT
-- YET BUILT as of 2026-08-06. The table is applied ahead of the code.
--
-- Safe to re-run.

create table if not exists outage_events (
  id                bigserial primary key,
  county            text not null,               -- 'montgomery' | 'ftbend'
  ftbend_office     text,                        -- null for montgomery
  outage_date       date not null,               -- Chicago local day
  kind              text not null,               -- 'pipeline' | 'hotline' | 'unknown'
  users_expected    integer not null default 0,
  users_affected    integer not null default 0,
  breakdown         jsonb,
  users_notified    integer not null default 0,
  declared_by       text not null default 'auto',
  all_clear_sent_at timestamptz,
  created_at        timestamptz not null default now()
);

-- One declaration per county/office/day: a cron re-run, a redeploy, or the
-- manual button after the automatic one cannot double-notify.
create unique index if not exists outage_events_day_uniq
  on outage_events (county, coalesce(ftbend_office, ''), outage_date);

alter table outage_events enable row level security;
drop policy if exists "outage_events_admin_read" on outage_events;
create policy "outage_events_admin_read" on outage_events for select
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.is_admin = true));
