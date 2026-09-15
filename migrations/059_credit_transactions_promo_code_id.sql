-- 059: credit_transactions.promo_code_id — the ledger names the code it paid for.
--
-- /me's promo array (§3, 2026-09-15) reports the credits a code granted AT
-- THE TIME, from the ledger row the redemption wrote. That row was found by
-- string-matching note = 'Promo code: X', which is the same coupling that
-- has bitten this codebase three times (the email subject sniff, the office
-- note keyword match, the byDayOfWeek prose): a note format change would
-- silently turn every credits number into null. This column makes it a
-- join. Both redeem paths pass the id through add_credits_with_ledger from
-- the deploy that follows this migration.
--
-- ORDER MATTERS: run this BEFORE deploying the code that passes
-- p_promo_code_id. The new parameter has a default, so the code running
-- today keeps working after this migration; the new code against the old
-- function would fail every promo grant (and unwind the redemption).
--
-- The function's signature changes, so it is DROPped and recreated rather
-- than replaced (CREATE OR REPLACE with a new parameter would leave the old
-- overload in place and every call ambiguous). Run the whole file as one
-- statement batch so no grant lands in the gap. Body otherwise identical to
-- migration 016 plus the one column.
--
-- Backfill: from the notes where they parse. Today that is one row.
-- Redemptions older than the ledger (migration 002) have no row to backfill
-- and stay credits: null on /me, as the contract says.
--
-- Safe to re-run. Supabase SQL editor, tracking insert in the same session.

ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS promo_code_id uuid REFERENCES promo_codes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS credit_transactions_promo_code_idx
  ON credit_transactions (user_id, promo_code_id)
  WHERE promo_code_id IS NOT NULL;

COMMENT ON COLUMN credit_transactions.promo_code_id IS
  'The promo code this grant paid for (source = promo). Written by add_credits_with_ledger since migration 059; backfilled once from the note. /me joins on it for the credits a redemption granted at the time.';

DROP FUNCTION IF EXISTS add_credits_with_ledger(uuid, integer, text, text, text, text, text);

CREATE OR REPLACE FUNCTION add_credits_with_ledger(
  p_user_id            uuid,
  p_amount             integer,
  p_source             text,
  p_note               text default null,
  p_performed_by       text default null,
  p_stripe_session_id  text default null,
  p_stripe_invoice_id  text default null,
  p_promo_code_id      uuid default null
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
    stripe_session_id, stripe_invoice_id, promo_code_id
  ) values (
    p_user_id, p_amount, null, p_source, p_note, p_performed_by,
    p_stripe_session_id, p_stripe_invoice_id, p_promo_code_id
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

-- Backfill from the notes that parse. Exact match on the format both redeem
-- paths have always written; anything else stays null and is visible as
-- such rather than guessed.
UPDATE credit_transactions ct
SET promo_code_id = pc.id
FROM promo_codes pc
WHERE ct.source = 'promo'
  AND ct.promo_code_id IS NULL
  AND upper(trim(ct.note)) = 'PROMO CODE: ' || upper(pc.code);

INSERT INTO schema_migrations (filename, note)
VALUES ('059_credit_transactions_promo_code_id.sql', 'promo_code_id on the ledger; add_credits_with_ledger gains p_promo_code_id; backfill from notes')
ON CONFLICT (filename) DO NOTHING;
