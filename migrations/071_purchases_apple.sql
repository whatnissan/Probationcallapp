-- 071: purchases record where a purchase came from, and Apple's facts about it.
--
-- `source` is 'stripe' for every existing row (both writers before this were
-- the Stripe webhook) and 'apple_iap' for App Store purchases.
--
-- Apple columns: the transaction (unique — one purchase row per App Store
-- transaction, the second idempotency key beside the ledger's), the
-- subscription it belongs to, the product, the environment ('Production' /
-- 'Sandbox'), and the price as Apple reports it (milliunits of `currency`).
-- amount_cents stays the USD revenue column: it is NULL for a Sandbox grant
-- and for a non-USD storefront, so neither ever counts as revenue.
--
-- Refunds reuse the existing refund columns (018). Apple may also reverse a
-- refund (REFUND_REVERSED); refund_reversed_at records that, and
-- apple_refund_notification_id is the notification that refunded it.
--
-- profiles.billing_flagged_at / billing_flag_reason: "flag the account for
-- me" (Dave, 2026-10-15). Set on an Apple refund; cleared by hand.
--
-- Safe to re-run.

-- 071.1
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'stripe';

-- 071.2
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS apple_transaction_id          text,
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id text,
  ADD COLUMN IF NOT EXISTS apple_product_id              text,
  ADD COLUMN IF NOT EXISTS apple_environment             text,
  ADD COLUMN IF NOT EXISTS apple_price_milliunits        bigint,
  ADD COLUMN IF NOT EXISTS currency                      text,
  ADD COLUMN IF NOT EXISTS storefront                    text,
  ADD COLUMN IF NOT EXISTS refund_reversed_at            timestamptz,
  ADD COLUMN IF NOT EXISTS apple_refund_notification_id  text;

-- 071.3
CREATE UNIQUE INDEX IF NOT EXISTS purchases_apple_transaction_id_uniq
  ON purchases (apple_transaction_id) WHERE apple_transaction_id IS NOT NULL;

-- 071.4
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS billing_flagged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS billing_flag_reason text;

-- 071.5
INSERT INTO schema_migrations (filename, note)
VALUES ('071_purchases_apple.sql', 'purchases.source + Apple transaction columns; profiles.billing_flagged_at/billing_flag_reason')
ON CONFLICT (filename) DO NOTHING;
