-- 035: log every in-app checkout tap, at tap time.
--
-- Why a separate table and not a column on `purchases`: the attribution has
-- to exist BEFORE a purchase does. A tap that never converts still has to be
-- countable, and `purchases` only gets a row when Stripe's webhook fires.
--
-- The link back to revenue is `stripe_session_id`, written here when we create
-- the session, joined to `purchases.stripe_session_id` later. That means the
-- webhook needs no change at all.
--
-- US external link-outs are 0% commission today, but a fee is coming on
-- remand. When a number lands, "which purchases originated in-app" has to be
-- answerable from records that already exist — it cannot be reconstructed.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS checkout_attributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  -- Where the tap came from. 'ios_app' is the one that matters for the fee;
  -- the column exists so web taps can be logged the same way later.
  source            text NOT NULL DEFAULT 'ios_app',
  intent            text NOT NULL,
  credit_count      integer,
  price_cents       integer NOT NULL,
  -- Null when Stripe session creation failed: the tap still happened, and a
  -- tap we couldn't convert is exactly the kind of thing we'd want to see.
  stripe_session_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkout_attributions_user
  ON checkout_attributions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_attributions_session
  ON checkout_attributions(stripe_session_id);

COMMENT ON TABLE checkout_attributions IS
  'One row per in-app checkout tap, written before the Stripe session exists. Join stripe_session_id to purchases.stripe_session_id to see which revenue originated in-app.';

-- Lock it down to match the rest of the schema. Every other table answers the
-- public anon key with "permission denied for table" (a GRANT denial, not an
-- RLS policy), and that anon key ships inside public/index.html — so a table
-- that merely inherits default privileges could end up being the one readable
-- table in the database. Revoke explicitly instead of trusting the default,
-- and enable RLS with no policies as a second lock. The server uses the
-- service key, which bypasses both, so nothing in the app changes.
REVOKE ALL ON checkout_attributions FROM anon, authenticated;
ALTER TABLE checkout_attributions ENABLE ROW LEVEL SECURITY;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('035_checkout_attributions.sql')
ON CONFLICT (filename) DO NOTHING;
