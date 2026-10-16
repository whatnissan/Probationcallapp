-- 072: App Store subscriptions, one row per subscription (originalTransactionId).
--
-- A separate table, not more profile columns: profiles.subscription_* are
-- Stripe's, stored verbatim, and a person can hold both kinds at once.
-- GET /me merges the two into one `subscription` (lib/subscription-state.js).
--
-- status is ours, already mapped from Apple's: 'active' | 'past_due' |
-- 'canceled' — the same three values §3 lets a client branch on.
--
-- user_id is ON DELETE SET NULL (Dave, 2026-10-15): deleting an account must
-- not delete this row, because Apple keeps sending notifications for a
-- subscription until it ends, and the row is how they are recognised. A
-- notification for a row with no user is logged and alerted, never granted.
--
-- RLS on, no policies: only the service role (the server) reads it.
--
-- Safe to re-run.

-- 072.1
CREATE TABLE IF NOT EXISTS apple_subscriptions (
  original_transaction_id text PRIMARY KEY,
  user_id                 uuid REFERENCES profiles(id) ON DELETE SET NULL,
  product_id              text NOT NULL,
  environment             text NOT NULL,
  status                  text NOT NULL,
  auto_renew              boolean,
  expires_at              timestamptz,
  last_transaction_id     text,
  duplicate_notified_at   timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- 072.2
CREATE INDEX IF NOT EXISTS apple_subscriptions_user_idx
  ON apple_subscriptions (user_id) WHERE user_id IS NOT NULL;

-- 072.3
ALTER TABLE apple_subscriptions ENABLE ROW LEVEL SECURITY;

-- 072.4
INSERT INTO schema_migrations (filename, note)
VALUES ('072_apple_subscriptions.sql', 'apple_subscriptions: one row per App Store subscription; user link SET NULL on account deletion')
ON CONFLICT (filename) DO NOTHING;
