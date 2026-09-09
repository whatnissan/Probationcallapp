-- 051: record the iOS BUILD number, not just the marketing version.
--
-- device_tokens.app_version holds CFBundleShortVersionString, which has
-- been "1.0" for every build shipped, so the server could not answer "is
-- anyone still on build 11?" — the question every field removal from the
-- API has to answer before it is safe (the 2026-09-07 byDayOfWeek hold).
--
-- The app does not send its build number, and older builds never will. But
-- URLSession's default User-Agent is "<executable>/<CFBundleVersion>
-- CFNetwork/… Darwin/…", the app does not override it, and CFBundleVersion
-- IS the build number. So the server reads it from the header on
-- registration and on /today polls. No app change, works for the builds we
-- are trying to retire.
--
-- Two homes because they answer two questions. device_tokens.app_build is
-- per device, exact, written on registration (the token identifies the
-- device). profiles.last_app_build is per person, written on /today too —
-- a poll carries no device token, so with two devices it cannot say WHICH
-- one polled, but "this person was last seen on build N" is exactly the
-- adoption fact a removal needs.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS app_build text;

COMMENT ON COLUMN device_tokens.app_build IS
  'CFBundleVersion (the build number) parsed from the User-Agent at registration. app_version is the marketing version and has been 1.0 for every build.';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS last_app_build    text,
  ADD COLUMN IF NOT EXISTS last_app_build_at timestamptz;

COMMENT ON COLUMN profiles.last_app_build IS
  'Highest-confidence recent build for this person: parsed from the User-Agent on device registration and /today polls. Per person, not per device.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('051_app_build.sql')
ON CONFLICT (filename) DO NOTHING;
