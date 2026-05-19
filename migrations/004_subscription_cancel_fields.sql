-- Migration: capture "canceling at period end" state from Stripe.
-- Additive: two new nullable columns on profiles. Existing rows default to
-- (false, null) which correctly represents "not currently canceling".
--
-- Stripe keeps subscription.status='active' for the full billing period after
-- a user cancels via the Customer Portal — the cancel signal lives on
-- subscription.cancel_at_period_end. Without these columns the app would
-- show "Subscription active" for an entire month after a customer canceled,
-- with no way to surface "canceling on <date>" in the UI.

alter table profiles
  add column if not exists subscription_cancel_at_period_end boolean default false;

alter table profiles
  add column if not exists subscription_cancel_at timestamptz;
