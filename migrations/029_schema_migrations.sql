-- migrations/029_schema_migrations.sql
--
-- Applied-migration tracking. Three of the first 26 migration files (013,
-- 014, 015) reached production late — or not at all until it broke something
-- — because nothing recorded which files had actually been run. This table
-- is the record; the startup check in server.js (checkMigrationDrift)
-- compares the files in migrations/ against the rows here on every boot and
-- logs loudly on any mismatch. Log-only by design: drift must never take
-- down the 5:05 AM calls.
--
-- PROCESS from here on: every time a migration is run in the SQL editor,
-- insert its row in the same session:
--   insert into schema_migrations (filename, note)
--   values ('0NN_name.sql', 'applied by <who>');
--
-- The backfill for 001–029 is intentionally NOT part of this file — it is a
-- statement of fact about production, run separately after the audit
-- confirms each file is live. See the backfill INSERT accompanying the
-- 2026-08-13 audit.

create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now(),
  note text
);

alter table schema_migrations enable row level security;

revoke all on table schema_migrations from anon;
revoke all on table schema_migrations from authenticated;
