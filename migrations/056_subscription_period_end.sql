-- 056: when the current paid period ends (contract §3 subscription.currentPeriodEnd).
--
-- The profile held status, the cancel flag and the cancel date, but not
-- when the period ends, so the app could not say "renews on the 15th" or
-- "ends on the 15th" — and until §3 gained a subscription object it could
-- not say anything about the subscription at all: a subscriber whose card
-- failed got one email and then, days later, got paused, with nothing in
-- between on the screen they look at.
--
-- Written from Stripe by every subscription webhook (checkout completion,
-- invoice.paid, customer.subscription.updated) and backfilled ONCE for the
-- subscriptions that predate it (scripts/backfill-subscription-period-end.js,
-- run after this migration and before the contract mirror, so the app never
-- sees null on a live subscription).
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;

COMMENT ON COLUMN profiles.subscription_current_period_end IS
  'End of the current paid period, from Stripe (contract §3 subscription.currentPeriodEnd). Next renewal for an active subscription, last day of access for a cancelling one. Written by the subscription webhooks; backfilled once from Stripe for subscriptions that predate it.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('056_subscription_period_end.sql')
ON CONFLICT (filename) DO NOTHING;
