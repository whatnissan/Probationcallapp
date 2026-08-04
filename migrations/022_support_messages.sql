-- migrations/022_support_messages.sql
-- Minimal in-app support: one row = one user message plus at most one reply.
--
-- Deliberately NOT a threads/messages model. Inbound email is not ingested,
-- so a follow-up from the user lands in the admin's own inbox; if it needs a
-- tracked answer it becomes a new row. Revisit only if volume demands it —
-- this is a 17-user product, not a helpdesk.
--
-- Safe to re-run.

create table if not exists support_messages (
  id           bigserial primary key,
  user_id      uuid not null references profiles(id) on delete cascade,
  -- Snapshot, so the message survives an email change or profile deletion
  -- cascade ordering, and so the admin can always see who wrote it.
  user_email   text not null,
  subject      text not null,
  body         text not null,
  status       text not null default 'open',   -- 'open' | 'answered' | 'closed'
  created_at   timestamptz not null default now(),
  reply_body   text,
  answered_at  timestamptz,
  answered_by  text                            -- admin email
);

create index if not exists support_messages_status_idx on support_messages (status, created_at desc);
create index if not exists support_messages_user_idx   on support_messages (user_id, created_at desc);

-- Server uses the service key and bypasses RLS; defence in depth, matching
-- credit_transactions (002), sms_opt_outs (020) and mass_sends (021).
alter table support_messages enable row level security;

drop policy if exists "support_messages_own_read" on support_messages;
create policy "support_messages_own_read" on support_messages
  for select using (auth.uid() = user_id);

drop policy if exists "support_messages_admin_read" on support_messages;
create policy "support_messages_admin_read" on support_messages
  for select using (
    exists (select 1 from profiles where profiles.id = auth.uid() and profiles.is_admin = true)
  );
