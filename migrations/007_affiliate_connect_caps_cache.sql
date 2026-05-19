-- Migration: cache the affiliate's Stripe Connect capability flags on
-- profiles so the admin UI and reporting can answer "is this affiliate
-- onboarded enough to receive transfers?" without a Stripe round-trip.
-- The values are pushed by the new account.updated webhook handler
-- (§1) and also opportunistically updated by the §6.B pre-transfer
-- check whenever it has to fetch fresh data.
--
-- All nullable: existing rows stay NULL ("we haven't checked yet"),
-- which the code treats as unknown rather than false. The Stripe API
-- remains authoritative for actual transfer decisions; these columns
-- are a cache for display and quick filtering.
--
-- Also adds a unique partial index on stripe_connect_id so the
-- account.updated handler's `eq('stripe_connect_id', account.id)`
-- lookup is fast.

alter table profiles
  add column if not exists stripe_connect_charges_enabled boolean;

alter table profiles
  add column if not exists stripe_connect_payouts_enabled boolean;

alter table profiles
  add column if not exists stripe_connect_details_submitted boolean;

alter table profiles
  add column if not exists stripe_connect_updated_at timestamptz;

create unique index if not exists profiles_stripe_connect_id_idx
  on profiles (stripe_connect_id)
  where stripe_connect_id is not null;
