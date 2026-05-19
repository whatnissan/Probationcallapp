-- Migration: store stripe_payment_intent on purchases so refund and dispute
-- webhooks can match a Stripe charge back to its originating purchase.
-- Additive: one nullable column + one partial unique index. Existing rows
-- stay NULL and aren't backfilled (forward-only — old purchases predate
-- the refund-clawback handler and would need manual admin action).
--
-- Why payment_intent specifically:
--   charge.refunded payload carries charge.payment_intent (always present).
--   charge.dispute.created payload carries dispute.payment_intent (always
--   present).
--   Storing this on the original purchase makes the clawback path a single
--   indexed lookup instead of a Stripe round-trip.
--
-- For subscription renewals we already have purchases.stripe_invoice_id, and
-- charge.invoice is also on the charge payload, so the handler falls back to
-- invoice_id matching when payment_intent isn't on the purchase row (old
-- subscription rows from before this migration).

alter table purchases
  add column if not exists stripe_payment_intent text;

-- Each PaymentIntent corresponds to exactly one purchase, so uniqueness is
-- safe and gives us idempotent matching. Partial so existing NULL rows
-- don't violate.
create unique index if not exists purchases_stripe_payment_intent_idx
  on purchases (stripe_payment_intent)
  where stripe_payment_intent is not null;
