-- 043: the App Review demo account flag.
--
-- App Store review needs working credentials with a populated dashboard, and
-- it cannot be a real subscriber's data. is_demo marks an account whose
-- morning cron WRITES a synthetic result instead of dialling the hotline —
-- the account looks live, Twilio is never called with its fake PIN, and no
-- SMS/email/push goes out. The same flag keeps the account out of every
-- pooled statistic (county range, county stats, funnel), so a fabricated
-- history never leaks into anyone's prediction.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN profiles.is_demo IS
  'App Review demo account: the scheduler writes synthetic results instead of dialling; excluded from all pooled statistics.';

INSERT INTO schema_migrations (filename)
VALUES ('043_profiles_is_demo.sql')
ON CONFLICT (filename) DO NOTHING;
