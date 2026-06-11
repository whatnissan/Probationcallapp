-- migrations/016_credit_grant_idempotency.sql
-- Make credit GRANTS idempotent at the database level, keyed on the Stripe
-- session id (bundles) / invoice id (subscriptions). Closes the C5 window:
-- the webhook checked the purchases table for a duplicate BEFORE granting,
-- but inserted the purchases row AFTER granting. A crash in between meant a
-- Stripe retry saw no purchases row and granted the credits a second time.
--
-- Fix: the ledger row itself becomes the atomic idempotency claim. Partial
-- unique indexes on the Stripe ids make a duplicate delivery hit
-- ON CONFLICT DO NOTHING inside add_credits_with_ledger, so the second
-- delivery returns the current balance without incrementing. One Stripe
-- event => at most one credit grant, even across crashes/retries/races.
--
-- Safe to re-run.

-- 1) Remove any pre-existing duplicate ledger rows for the same Stripe id
--    (a historical double-credit would block the unique index). Keep the
--    earliest row per id; this cleans the ledger record (it does not change
--    anyone's current balance).
delete from credit_transactions a using credit_transactions b
  where a.stripe_session_id is not null
    and a.stripe_session_id = b.stripe_session_id
    and a.id > b.id;

delete from credit_transactions a using credit_transactions b
  where a.stripe_invoice_id is not null
    and a.stripe_invoice_id = b.stripe_invoice_id
    and a.id > b.id;

-- 2) Enforce one ledger row per Stripe id (partial: ignores NULLs, so admin
--    grants / signup / promo / referral rows with no Stripe id are unaffected).
create unique index if not exists credit_transactions_stripe_session_uniq
  on credit_transactions (stripe_session_id) where stripe_session_id is not null;
create unique index if not exists credit_transactions_stripe_invoice_uniq
  on credit_transactions (stripe_invoice_id) where stripe_invoice_id is not null;

-- 3) Idempotent grant: claim via the ledger insert first, only increment if
--    we won the claim. Replaces the migration 002 version (same signature,
--    same return = new balance; on a duplicate it returns the CURRENT balance
--    without re-incrementing).
create or replace function add_credits_with_ledger(
  p_user_id            uuid,
  p_amount             integer,
  p_source             text,
  p_note               text default null,
  p_performed_by       text default null,
  p_stripe_session_id  text default null,
  p_stripe_invoice_id  text default null
) returns integer
language plpgsql
as $$
declare
  v_new_balance integer;
  v_ledger_id   bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'add_credits_with_ledger: amount must be positive, got %', p_amount;
  end if;

  -- Idempotency claim. balance_after is backfilled once we know the balance.
  insert into credit_transactions (
    user_id, amount, balance_after, source, note, performed_by,
    stripe_session_id, stripe_invoice_id
  ) values (
    p_user_id, p_amount, null, p_source, p_note, p_performed_by,
    p_stripe_session_id, p_stripe_invoice_id
  )
  on conflict do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    -- Duplicate Stripe event: already granted. Return current balance,
    -- do NOT increment again.
    select credits into v_new_balance from profiles where id = p_user_id;
    return v_new_balance;
  end if;

  update profiles
    set credits = coalesce(credits, 0) + p_amount
    where id = p_user_id
    returning credits into v_new_balance;

  if v_new_balance is null then
    raise exception 'add_credits_with_ledger: profile not found for user %', p_user_id;
  end if;

  update credit_transactions set balance_after = v_new_balance where id = v_ledger_id;
  return v_new_balance;
end;
$$;
