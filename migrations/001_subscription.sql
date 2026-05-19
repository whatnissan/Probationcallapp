-- Migration: add subscription support to profiles + purchases.
-- RUN THIS BEFORE DEPLOYING THE SUBSCRIPTION CODE — without these columns,
-- the new webhook handlers will return 500 on every invoice.paid event.

-- profiles: track each user's subscription
alter table profiles add column if not exists stripe_customer_id text;
alter table profiles add column if not exists stripe_subscription_id text;
alter table profiles add column if not exists subscription_status text;

create unique index if not exists profiles_stripe_customer_id_idx
  on profiles (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists profiles_stripe_subscription_id_idx
  on profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- purchases: idempotency key for recurring subscription invoices.
-- The existing stripe_session_id column already handles one-time bundles;
-- this adds an analogous key for renewals (which don't have a session).
alter table purchases add column if not exists stripe_invoice_id text;

create unique index if not exists purchases_stripe_invoice_id_idx
  on purchases (stripe_invoice_id)
  where stripe_invoice_id is not null;
