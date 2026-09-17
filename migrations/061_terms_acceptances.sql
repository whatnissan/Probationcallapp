-- 061: terms_acceptances — the record that someone agreed, to which text, when.
--
-- The Terms of Service hold the liability waiver, the assumption of risk,
-- the no-accuracy guarantee and the indemnification: the clauses that
-- matter if a wrong or missing result leads to a missed test. They protect
-- nothing unless we can show this person agreed. Until now the only record
-- was profiles.terms_accepted_at — a bare timestamp, no version, written
-- only by the website. The app's liability step required a tap and posted
-- nothing, so every app-onboarded account has no record at all (four real
-- subscribers on 2026-09-17). Their record starts when they next accept;
-- nothing here infers one.
--
-- APPEND-ONLY, one row per (account, version). Never updated except to
-- anonymise, never deleted. Unique (user_id, terms_version) makes accepting
-- the same version twice a no-op at the database; NULL user_ids are
-- distinct, so anonymised rows never collide.
--
-- ACCOUNT DELETION (Dave's ruling, 2026-09-17): user_id is nulled by the FK
-- and the deletion endpoints write the email tombstone hash (the same
-- SHA-256 of the normalised email that deleted_account_tombstones holds)
-- onto the rows first. A record with no identifier proves nothing about
-- who agreed.
--
-- VERSIONS are the Terms page's Last Updated date, YYYY-MM-DD. Two texts
-- have been live, proven by git:
--   2025-12-04  7a58659, the original.
--   2026-08-24  6e93109 (committed 2026-08-24 12:41:27 CDT), removed
--               WhatsApp from the service description. The page's Last
--               Updated date was not changed then; it is corrected by hand
--               alongside this migration.
-- The backfill maps each existing website acceptance to the text served at
-- that moment using its ORIGINAL server timestamp (25 before, 3 after). No
-- acceptance falls on 2026-08-24, so the boundary is unambiguous.
--
-- profiles.terms_version is the pointer beside the existing
-- terms_accepted_at: the newest version this account accepted, which the
-- admin list and /me read. The table is the record.
--
-- Safe to re-run. Run BEFORE the deploy (the new routes write the table).
-- Supabase SQL editor, tracking insert in the same session.

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  terms_version  text NOT NULL CHECK (terms_version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL CHECK (source IN ('web_modal', 'app', 'backfill_web')),
  ip             text,
  app_build      text,
  email_hash     text,
  CONSTRAINT terms_acceptances_user_version_uniq UNIQUE (user_id, terms_version)
);

CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx
  ON terms_acceptances (user_id, accepted_at DESC);

COMMENT ON TABLE terms_acceptances IS
  'Append-only record of Terms of Service acceptance: account, version (Last Updated date), server timestamp, source, IP, app build. Survives account deletion with user_id nulled and the email tombstone hash kept.';

REVOKE ALL ON terms_acceptances FROM anon, authenticated;
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS terms_version text;

COMMENT ON COLUMN profiles.terms_version IS
  'Newest Terms version this account accepted (pointer; the record is terms_acceptances). Set with terms_accepted_at.';

-- Backfill: every existing website acceptance, at its original timestamp,
-- with the version the website served at that moment.
INSERT INTO terms_acceptances (user_id, terms_version, accepted_at, source)
SELECT p.id,
       CASE WHEN p.terms_accepted_at < '2026-08-24T17:41:27Z' THEN '2025-12-04' ELSE '2026-08-24' END,
       p.terms_accepted_at,
       'backfill_web'
FROM profiles p
WHERE p.terms_accepted_at IS NOT NULL
ON CONFLICT (user_id, terms_version) DO NOTHING;

UPDATE profiles
SET terms_version = CASE WHEN terms_accepted_at < '2026-08-24T17:41:27Z' THEN '2025-12-04' ELSE '2026-08-24' END
WHERE terms_accepted_at IS NOT NULL
  AND terms_version IS NULL;

INSERT INTO schema_migrations (filename, note)
VALUES ('061_terms_acceptances.sql', 'append-only terms acceptance record; profiles.terms_version; 25/3 backfill by original timestamp')
ON CONFLICT (filename) DO NOTHING;
