-- Migration: track Stripe transfer outcome on affiliate_earnings.
-- Additive: two nullable columns + one partial index. Existing rows are
-- unaffected; columns default to NULL.
--
-- After this migration the affiliate_earnings.status values are:
--   'transferred' — Stripe transfer succeeded; stripe_transfer_id populated
--   'credited'    — non-Connect affiliate; commission accrued to
--                   affiliate_balance_cents for manual PayPal payout
--   'failed'      — Connect affiliate, Stripe transfer rejected;
--                   error_message populated; admin can retry via
--                   POST /api/admin/affiliate-earnings/:id/retry
--   'reversed'    — (future) commission clawed back after refund/dispute

alter table affiliate_earnings
  add column if not exists stripe_transfer_id text;

alter table affiliate_earnings
  add column if not exists error_message text;

-- Partial index speeds up the admin "list failed earnings" query without
-- bloating storage for the common 'transferred' / 'credited' rows.
create index if not exists affiliate_earnings_failed_idx
  on affiliate_earnings (status, created_at desc)
  where status = 'failed';
