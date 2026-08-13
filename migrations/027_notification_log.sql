-- migrations/027_notification_log.sql
--
-- RETROACTIVE RECORD. The notification_log table (feature landed in commit
-- 062c179) was created by hand in the Supabase SQL editor and never got a
-- migration file — found by the 2026-08-13 migrations-vs-production audit.
-- Everything below is transcribed from the LIVE production schema (PostgREST
-- OpenAPI introspection + anon-key permission probe, 2026-08-13), not
-- redesigned. Running this against production is a no-op (if not exists /
-- idempotent revokes).
--
-- Introspection limits, for anyone rebuilding from scratch:
--   * id shows as "bigint, primary key" over the API; whether prod used
--     BIGSERIAL or GENERATED IDENTITY is not visible. IDENTITY below is the
--     Supabase convention and is equivalent for every reader/writer in
--     server.js.
--   * Indexes are not visible over the API; none are declared here. If prod
--     has any beyond the primary key, they are still untracked.

create table if not exists notification_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  channel text not null,
  kind text not null,
  destination text,
  body_preview text,
  status text not null,
  error text,
  provider_message_id text,
  delivery_status text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

-- Verified live 2026-08-13: anon reads fail with 42501 (permission denied),
-- matching the service-role-only lockdown pattern of the day.
alter table notification_log enable row level security;

revoke all on table notification_log from anon;
revoke all on table notification_log from authenticated;
