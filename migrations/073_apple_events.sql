-- 073: every App Store event we receive — the app's POSTed transactions and
-- Apple's Server Notifications V2 — and what we did about it.
--
-- Two jobs. It is the idempotency record for notifications (notification_uuid
-- is unique: a redelivery that already finished is acknowledged and skipped;
-- one that failed part-way is processed again, every step being idempotent
-- on its own). And it is the audit log: a Sandbox purchase that grants
-- nothing (Dave, 2026-10-15) is RECORDED here, with outcome
-- 'sandbox_not_granted', and never touches purchases or the ledger.
--
-- user_id is ON DELETE SET NULL, like apple_subscriptions. RLS on, no policies.
--
-- Safe to re-run.

-- 073.1
CREATE TABLE IF NOT EXISTS apple_events (
  id                      bigserial PRIMARY KEY,
  source                  text NOT NULL,
  notification_uuid       text UNIQUE,
  notification_type       text,
  subtype                 text,
  environment             text,
  transaction_id          text,
  original_transaction_id text,
  product_id              text,
  user_id                 uuid REFERENCES profiles(id) ON DELETE SET NULL,
  outcome                 text,
  detail                  text,
  received_at             timestamptz NOT NULL DEFAULT now(),
  processed_at            timestamptz
);

-- 073.2
CREATE INDEX IF NOT EXISTS apple_events_transaction_idx
  ON apple_events (transaction_id) WHERE transaction_id IS NOT NULL;

-- 073.3
ALTER TABLE apple_events ENABLE ROW LEVEL SECURITY;

-- 073.4
INSERT INTO schema_migrations (filename, note)
VALUES ('073_apple_events.sql', 'apple_events: App Store notifications and app-posted transactions, idempotency + audit log')
ON CONFLICT (filename) DO NOTHING;
