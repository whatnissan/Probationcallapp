-- migrations/018_refund_support.sql
--
-- RECONSTRUCTION. Applied to production 2026-08-04; this file was written
-- 2026-08-06. The SQL below is verbatim what was run.
-- Verified applied by selecting the refund columns from purchases (all
-- resolved) and by calling deduct_credits_capped with amount 0, which raised
-- its own argument-validation error rather than "function does not exist".
--
-- !! SUPERSEDED IN PART BY 019 !!
-- The deduct_credits_capped defined here contains an arithmetic bug: it
-- computes the taken-amount inside RETURNING, where a bare column name is the
-- POST-update value. It returned a large negative number and, because the
-- ledger insert is guarded on v_taken > 0, skipped the ledger entirely while
-- still decrementing the balance. Migration 019 replaces this function.
-- Anyone replaying migrations MUST apply 019 after this file.
--
-- Admin refund support: columns on purchases to record a refund, and a capped
-- deduction so clawing back more credits than a user still holds floors at
-- zero instead of refusing outright (the existing deduct_credit_with_ledger
-- guard is all-or-nothing).
--
-- Safe to re-run.

alter table purchases
  add column if not exists refunded_at            timestamptz,
  add column if not exists refund_amount_cents    integer,
  add column if not exists refund_stripe_id       text,
  add column if not exists refund_performed_by    text,
  add column if not exists refund_credits_clawed  integer;

create unique index if not exists purchases_refund_stripe_id_uniq
  on purchases (refund_stripe_id) where refund_stripe_id is not null;

create or replace function deduct_credits_capped(
  p_user_id uuid, p_amount integer, p_source text, p_note text default null
) returns integer
language plpgsql as $$
declare v_taken integer; v_new integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'deduct_credits_capped: amount must be positive, got %', p_amount;
  end if;
  update profiles
     set credits = greatest(0, coalesce(credits,0) - p_amount)
   where id = p_user_id
   returning coalesce(credits,0), least(p_amount, coalesce(credits,0) + p_amount) - coalesce(credits,0)
        into v_new, v_taken;
  if not found then return null; end if;
  if v_taken > 0 then
    insert into credit_transactions (user_id, amount, balance_after, source, note)
    values (p_user_id, -v_taken, v_new, p_source, p_note);
  end if;
  return v_taken;
end; $$;
