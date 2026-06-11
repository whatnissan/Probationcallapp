-- migrations/015_deduct_credit_rpc.sql
-- Atomic credit DEDUCTION + ledger insert, mirroring add_credits_with_ledger
-- (migration 002). The add path went through an atomic RPC; the deduct path
-- (deductCreditOnce in server.js) was still a read-modify-write:
--   read credits -> compute credits-1 -> update credits
-- Two same-moment deductions could both read the same balance and both write
-- balance-1, losing a deduction (and the deduct path skipped the ledger
-- entirely). This closes both: a single guarded UPDATE serializes on the row
-- lock, and the ledger row is written in the same transaction.
--
-- Deductions are recorded with a NEGATIVE amount and source
-- 'call_deduction', so the credit_transactions ledger is now a complete
-- record of both adds and call-completion deductions.
--
-- Idempotent / safe to re-run: create or replace.

create or replace function deduct_credit_with_ledger(
  p_user_id  uuid,
  p_amount   integer,
  p_source   text default 'call_deduction',
  p_note     text default null
) returns integer
language plpgsql
as $$
declare v_new_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'deduct_credit_with_ledger: amount must be positive, got %', p_amount;
  end if;

  -- Atomic guard: decrement ONLY if the balance can cover it. Concurrent
  -- callers serialize on the row lock, so two same-moment deductions can
  -- never lose an update or drive the balance negative.
  update profiles
    set credits = credits - p_amount
    where id = p_user_id and coalesce(credits, 0) >= p_amount
    returning credits into v_new_balance;

  -- No row updated => profile missing OR insufficient credits. Caller treats
  -- null as "did not deduct" (returns false), same as the old behavior.
  if not found then
    return null;
  end if;

  insert into credit_transactions (user_id, amount, balance_after, source, note)
    values (p_user_id, -p_amount, v_new_balance, p_source, p_note);

  return v_new_balance;
end;
$$;
