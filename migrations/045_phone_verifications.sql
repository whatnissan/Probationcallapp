-- 045: server-side phone verification (§4.17).
--
-- The app generated its verification code locally and only ever showed it in
-- a Debug chip, so on TestFlight no SMS went out and nobody could sign up.
-- Codes now live here: an HMAC of the code (under PHONE_VERIFY_SECRET, a
-- Railway variable — a database leak reveals nothing), a ten-minute expiry,
-- an attempt counter, and a row per SEND so the per-account, per-phone and
-- global daily limits are counted from durable data rather than an
-- in-memory map that resets on deploy.
--
-- profiles.verified_phone is what PUT /schedule checks when SMS is a chosen
-- method (v1 only; the website keeps its behaviour so live web schedules are
-- not stranded).
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS phone_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  phone         text NOT NULL,
  code_hmac     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  superseded_at timestamptz,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user ON phone_verifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_phone ON phone_verifications (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_created ON phone_verifications (created_at DESC);
COMMENT ON TABLE phone_verifications IS
  'One row per verification SMS sent. code_hmac only — the code itself is never stored or returned. Rows are the rate-limit ledger.';
REVOKE ALL ON phone_verifications FROM anon, authenticated;
ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified_phone text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified_phone_at timestamptz;
COMMENT ON COLUMN profiles.verified_phone IS
  'E.164 number proven by POST /phone/verify/check. v1 PUT /schedule requires notify_number to equal this when SMS is chosen.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('045_phone_verifications.sql')
ON CONFLICT (filename) DO NOTHING;
