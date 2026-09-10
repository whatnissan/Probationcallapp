-- 053: profiles.referral_code had THREE indexes. Keep one.
--
-- Found during the 2026-09-09 backlog audit and dropped by hand in the
-- Supabase SQL editor the same day. This file is the RECORD of that, so the
-- repo can rebuild production and so nobody re-adds them:
--
--   profiles_referral_code_key     — auto-created by a UNIQUE clause on the
--                                    original CREATE TABLE (dashboard era,
--                                    never in migrations/).      DROPPED.
--   idx_profiles_referral_code     — a plain, non-unique index added by
--                                    hand; redundant next to any unique
--                                    index on the same column.   DROPPED.
--   profiles_referral_code_unique  — the constraint migration 008 added and
--                                    tracks. It checked only for its own
--                                    name before adding, which is how a
--                                    second unique index appeared. KEPT.
--
-- One unique constraint serves both jobs: it enforces uniqueness for the
-- affiliate resolver and it is the index every referral_code lookup uses.
-- Do not add an index on this column. If uniqueness ever needs to become
-- case-insensitive, ALTER the kept constraint into a functional unique
-- index in a new migration — do not add a second one beside it.
--
-- Idempotent: safe to run on a database where the drops already happened.
-- The auto-created one was a constraint, so it goes via DROP CONSTRAINT;
-- DROP INDEX on a constraint's index is refused.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_referral_code_key;

DROP INDEX IF EXISTS idx_profiles_referral_code;

-- Guard: the one we keep must still exist. Fails loudly rather than leaving
-- referral_code with no uniqueness at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_referral_code_unique'
  ) THEN
    RAISE EXCEPTION 'profiles_referral_code_unique is missing — re-run migrations/008_profiles_referral_code_unique.sql before dropping anything else';
  END IF;
END $$;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('053_drop_duplicate_referral_code_indexes.sql')
ON CONFLICT (filename) DO NOTHING;
