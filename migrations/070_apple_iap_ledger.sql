-- 070: the credit ledger learns Apple transaction ids (In-App Purchase, build 23).
--
-- Every Apple grant is keyed on the App Store `transactionId` — one per
-- purchase AND one per subscription renewal. NOT the originalTransactionId:
-- that names the subscription and repeats on every renewal, so keying on it
-- would grant the first month and swallow every renewal after it.
--
-- The unique partial index makes the ledger row the atomic idempotency claim,
-- exactly as migration 016 did for Stripe: the app's POST and Apple's
-- notification for the same transaction can race, retry, or both arrive,
-- and only one grant lands.
--
-- ORDER MATTERS: run this BEFORE deploying the code that passes
-- p_apple_transaction_id. The new parameter has a default, so the code running
-- today keeps working after it. The signature changes, so the function is
-- DROPped and recreated (a CREATE OR REPLACE with a new parameter would leave
-- the old overload in place and make every call ambiguous). Run 070.3 and
-- 070.4 back to back: a Stripe grant that lands in the gap fails and Stripe
-- retries it, but there is no reason to leave a gap. Body otherwise identical
-- to migration 059 plus the one column.
--
-- Safe to re-run. Supabase SQL editor, tracking insert in the same session.

-- 070.1
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS apple_transaction_id text;

-- 070.2
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_apple_txn_uniq
  ON credit_transactions (apple_transaction_id) WHERE apple_transaction_id IS NOT NULL;

-- 070.3
DROP FUNCTION IF EXISTS add_credits_with_ledger(uuid, integer, text, text, text, text, text, uuid);

-- 070.4
CREATE OR REPLACE FUNCTION add_credits_with_ledger(
  p_user_id              uuid,
  p_amount               integer,
  p_source               text,
  p_note                 text default null,
  p_performed_by         text default null,
  p_stripe_session_id    text default null,
  p_stripe_invoice_id    text default null,
  p_promo_code_id        uuid default null,
  p_apple_transaction_id text default null
) RETURNS integer
LANGUAGE plpgsql
AS $$
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
    stripe_session_id, stripe_invoice_id, promo_code_id, apple_transaction_id
  ) values (
    p_user_id, p_amount, null, p_source, p_note, p_performed_by,
    p_stripe_session_id, p_stripe_invoice_id, p_promo_code_id, p_apple_transaction_id
  )
  on conflict do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    -- Duplicate Stripe event or Apple transaction: already granted. Return
    -- the current balance, do NOT increment again.
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

-- 070.5
INSERT INTO schema_migrations (filename, note)
VALUES ('070_apple_iap_ledger.sql', 'credit_transactions.apple_transaction_id (unique); add_credits_with_ledger gains p_apple_transaction_id')
ON CONFLICT (filename) DO NOTHING;
