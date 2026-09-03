-- Migration: persist the Stripe Connect `requirements` hash on profiles so
-- the server can answer "what is this affiliate actually waiting on?"
-- without a Stripe round-trip.
--
-- Migration 007 cached three booleans (charges_enabled, payouts_enabled,
-- details_submitted). That is not enough to tell two very different states
-- apart: an account Stripe is REVIEWING, and an account that still owes
-- documents. lib/affiliate.js connectState() currently reports both as
-- 'pending_review' because details_submitted is all it has to go on, and
-- API_CONTRACT.md §4.14 ships that value straight to the app — where §1
-- requires the client to degrade HONESTLY. It cannot, on data this thin.
--
-- These four columns are written by the account.updated handler on the
-- Connect webhook endpoint (/webhook/stripe/connect). They carry the
-- requirements hash verbatim:
--   currently_due   — needed now to keep the account enabled
--   eventually_due  — will be needed later
--   past_due        — deadline missed; this is the "blocked right now" set
--   disabled_reason — Stripe's own string for why the account is limited
--
-- jsonb, not text[]: the three *_due fields are Stripe arrays of opaque
-- requirement ids that we store and forward without interpreting. jsonb
-- round-trips them through supabase-js unchanged and leaves room for the
-- shape to grow on Stripe's side without another migration.
--
-- All nullable, matching the 007 convention: NULL means "we have not heard
-- from Stripe yet", which the code must treat as UNKNOWN and never as
-- "nothing is due". An empty array [] is the real "nothing is due".
--
-- Per migration 029 discipline this file inserts its own tracking row.
-- Five statements, one per block — run them one at a time.

alter table profiles add column if not exists stripe_connect_requirements_currently_due jsonb;

alter table profiles add column if not exists stripe_connect_requirements_eventually_due jsonb;

alter table profiles add column if not exists stripe_connect_requirements_past_due jsonb;

alter table profiles add column if not exists stripe_connect_disabled_reason text;

insert into schema_migrations (filename) values ('048_connect_requirements.sql') on conflict (filename) do nothing;
