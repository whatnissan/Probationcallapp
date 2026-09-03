-- 047: affiliate commissions — accrue, hold, pay (Stripe Connect Express).
--
-- Commissions stop being transferred at the moment of sale. Each one is a
-- ledger row HELD for 30 days (refund in the window = no money moved), then
-- AVAILABLE, then PAID by a monthly batch: one transfer per affiliate, at or
-- above the $20 minimum, to an Express account that is payouts-enabled.
-- payout_batches records each such transfer so a month reconciles as one
-- row per affiliate against the earning rows it paid.
--
-- No backfill: production holds zero affiliate_earnings rows. The status
-- vocabulary is now held | available | paid | reversed | reversal_failed |
-- failed; the old 'transferred' and 'credited' are read as paid/available.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE affiliate_earnings ADD COLUMN IF NOT EXISTS available_at timestamptz;
ALTER TABLE affiliate_earnings ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE affiliate_earnings ADD COLUMN IF NOT EXISTS payout_batch_id uuid;
CREATE INDEX IF NOT EXISTS idx_affiliate_earnings_affiliate_status ON affiliate_earnings (affiliate_id, status);

CREATE TABLE IF NOT EXISTS payout_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id       uuid NOT NULL,
  amount_cents       integer NOT NULL,
  earning_count      integer NOT NULL,
  transfer_group     text NOT NULL,
  stripe_transfer_id text,
  status             text NOT NULL DEFAULT 'pending',   -- pending | paid | failed
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  CONSTRAINT payout_batches_status_check CHECK (status IN ('pending', 'paid', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_payout_batches_affiliate ON payout_batches (affiliate_id, created_at DESC);
COMMENT ON TABLE payout_batches IS
  'One row per monthly Connect transfer to an affiliate. The earning rows it paid carry its id in payout_batch_id.';
REVOKE ALL ON payout_batches FROM anon, authenticated;
ALTER TABLE payout_batches ENABLE ROW LEVEL SECURITY;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('047_affiliate_hold_and_batches.sql')
ON CONFLICT (filename) DO NOTHING;
