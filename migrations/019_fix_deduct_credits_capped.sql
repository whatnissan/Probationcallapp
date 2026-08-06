-- migrations/019_fix_deduct_credits_capped.sql
--
-- RECONSTRUCTION. Applied to production 2026-08-04; this file was written
-- 2026-08-06. The SQL below is verbatim what was run.
-- Verified applied by calling deduct_credits_capped against a profile with a
-- zero balance: the fixed version returns 0 and writes nothing, while the 018
-- version would have returned the full requested amount and inserted a bogus
-- ledger row. The probe returned 0 with the ledger count unchanged.
--
-- CORRECTS migration 018. Do not apply 018 without this file.
--
-- 018 computed the taken-amount inside the RETURNING clause, where a bare
-- column name is the POST-update value. With a balance of 10034 and a request
-- for 30 it evaluated least(30, 10004+30) - 10004 = -9974, and because the
-- ledger insert is guarded on v_taken > 0, NO ledger row was written — while
-- the UPDATE had already decremented the balance by 30.
--
-- Live consequence on 2026-08-04: a refund reclaimed 30 credits with no
-- ledger entry and recorded refund_credits_clawed = -9974. The balance was
-- correct; the audit trail was not. Repaired by hand afterwards.
--
-- Fix: read the old balance under a row lock BEFORE updating, so the taken
-- amount is computed from a value that has not already changed.
--
-- Safe to re-run.

create or replace function deduct_credits_capped(
  p_user_id uuid, p_amount integer, p_source text, p_note text default null
) returns integer
language plpgsql as $$
declare v_old integer; v_taken integer; v_new integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'deduct_credits_capped: amount must be positive, got %', p_amount;
  end if;
  select coalesce(credits,0) into v_old from profiles where id = p_user_id for update;
  if not found then return null; end if;
  v_taken := least(p_amount, v_old);
  v_new   := v_old - v_taken;
  update profiles set credits = v_new where id = p_user_id;
  if v_taken > 0 then
    insert into credit_transactions (user_id, amount, balance_after, source, note)
    values (p_user_id, -v_taken, v_new, p_source, p_note);
  end if;
  return v_taken;
end; $$;
