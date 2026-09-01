-- 037: APNs device registrations (contract §4.12 POST /devices).
--
-- UNIQUE ON token, NOT on user_id. One user has several devices, and the same
-- device can move between accounts (a phone gets handed on, or someone signs
-- in with a different account). The token is the thing APNs addresses, so it
-- is the identity here; registration upserts on it and reassigns user_id.
--
-- Pruning is a SOFT delete. APNs reports dead tokens on the feedback path, and
-- unregistered_at records that rather than dropping the row, so a token that
-- comes back can be told apart from one we have never seen. A hard delete
-- would also lose the only evidence that we stopped being able to reach
-- someone — which, for a service whose whole job is telling people they must
-- test today, is exactly the failure worth being able to audit.
--
-- Locked down like every other table (the lesson from 035): the public anon
-- key that ships in index.html must get "permission denied", never a list of
-- push tokens. Revoked explicitly rather than trusting default privileges,
-- with RLS as a second lock. The server uses the service key and bypasses both.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS device_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  token           text NOT NULL UNIQUE,
  platform        text NOT NULL DEFAULT 'ios',
  -- APNs sandbox and production are separate address spaces: a token minted
  -- against one is invalid on the other, so the environment has to travel
  -- with the token or TestFlight builds silently fail to receive anything.
  environment     text NOT NULL DEFAULT 'production',
  app_version     text,
  os_version      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Refreshed on every re-registration, so a stale device is identifiable
  -- even before APNs tells us it is gone.
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  unregistered_at timestamptz
);

ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_platform_check;
ALTER TABLE device_tokens
  ADD CONSTRAINT device_tokens_platform_check CHECK (platform IN ('ios', 'android'));

ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_environment_check;
ALTER TABLE device_tokens
  ADD CONSTRAINT device_tokens_environment_check CHECK (environment IN ('production', 'sandbox'));

-- The send path asks "which live devices does this user have?" — index that,
-- and only over rows that can still receive anything.
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_live
  ON device_tokens(user_id) WHERE unregistered_at IS NULL;

COMMENT ON TABLE device_tokens IS
  'APNs registrations per contract §4.12. Unique on token, not user_id: one user may have several devices and a device may change hands. Dead tokens are soft-deleted via unregistered_at so an unreachable subscriber stays auditable.';

REVOKE ALL ON device_tokens FROM anon, authenticated;
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('037_device_tokens.sql')
ON CONFLICT (filename) DO NOTHING;
