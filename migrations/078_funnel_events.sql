-- 078: funnel_events — how far people get, and where they come from.
--
-- Build 25 removes the code field from the app: a partner ID is typed on
-- probationcall.com, in the browser, and the app only makes the trip
-- possible. That buys the review posture but costs visibility, so the
-- measurement moves one layer down:
--
--   * the app reports its own steps (`onboarding_partner_asked`,
--     `_answered`, `_left`, `_returned`, `_applied`, `_not_applied`,
--     `_abandoned`, §4.21) — the funnel around the trip, which only the
--     app can see;
--   * the redeem page reports `redeem_page_open` with the `src` the link
--     carried (ios-onboarding / ios-account / ios-buy), so a visit from
--     setup is told from one from Account or the buy sheet;
--   * `POST /api/v1/redeem` reports `redeem_success` / `redeem_failed`
--     with the reason, so a page that opened and went nowhere is visible
--     as such rather than as a gap.
--
-- Nothing here is a session, a token, or a device id. `user_id` is the
-- authenticated account and is nullable because the page-open beacon can
-- arrive before anyone signs in on the website.
--
-- RLS on with no policies: the server writes and reads it, nothing else.
-- Safe to re-run. Supabase SQL editor, one statement per block, tracking
-- insert last.

-- 078.1
CREATE TABLE IF NOT EXISTS funnel_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  name       text NOT NULL,
  src        text,
  props      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 078.2
CREATE INDEX IF NOT EXISTS funnel_events_name_created_idx
  ON funnel_events (name, created_at DESC);

-- 078.3
CREATE INDEX IF NOT EXISTS funnel_events_created_idx
  ON funnel_events (created_at DESC);

-- 078.4
ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;

-- 078.5
INSERT INTO schema_migrations (filename, note)
VALUES ('078_funnel_events.sql', 'funnel_events: onboarding partner-ID funnel events (§4.14c), redeem page opens with src, redeem success/failure reasons')
ON CONFLICT (filename) DO NOTHING;
