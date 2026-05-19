-- Migration: per-account credit ledger.
-- Additive: creates one new table + one RPC. Does not alter any existing
-- tables. Safe to re-run — backfill is idempotent (it skips purchases rows
-- already represented in credit_transactions by stripe_session_id or
-- stripe_invoice_id).
--
-- This ledger records every credit ADD (admin grants, bundle purchases,
-- subscription payments, signup/referral bonuses, promo redemptions).
-- Call-completion DEDUCTIONS are NOT tracked here — that's a separate
-- concern (see deductCreditOnce in server.js).

create table if not exists credit_transactions (
  id            bigserial primary key,
  user_id       uuid not null references profiles(id) on delete cascade,
  amount        integer not null,                    -- always positive for adds
  balance_after integer,                             -- nullable: NULL for backfilled rows whose historical balance can't be reconstructed
  source        text not null,                       -- 'admin_grant' | 'bundle_purchase' | 'subscription_initial' | 'subscription_renewal' | 'signup_bonus' | 'referral_bonus' | 'promo' | 'other'
  note          text,
  performed_by  text,                                -- admin email for manual grants; null for system-triggered
  stripe_session_id  text,                           -- bundle purchases
  stripe_invoice_id  text,                           -- subscription payments
  created_at    timestamptz not null default now()
);

create index if not exists credit_transactions_user_id_idx
  on credit_transactions (user_id, created_at desc);

-- RLS: server uses service key (bypasses RLS), so this only matters if
-- anything ever queries from the anon/authenticated key. Restrict reads
-- to admins as a defense-in-depth.
alter table credit_transactions enable row level security;

drop policy if exists "credit_transactions_admin_read" on credit_transactions;
create policy "credit_transactions_admin_read"
  on credit_transactions
  for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.is_admin = true
    )
  );

-- Atomic balance-update + ledger-insert. Server calls this RPC instead of
-- doing the two writes separately, so they can't drift apart on a partial
-- failure. Returns the new balance.
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
declare v_new_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'add_credits_with_ledger: amount must be positive, got %', p_amount;
  end if;

  update profiles
    set credits = coalesce(credits, 0) + p_amount
    where id = p_user_id
    returning credits into v_new_balance;

  if v_new_balance is null then
    raise exception 'add_credits_with_ledger: profile not found for user %', p_user_id;
  end if;

  insert into credit_transactions (
    user_id, amount, balance_after, source, note, performed_by,
    stripe_session_id, stripe_invoice_id
  ) values (
    p_user_id, p_amount, v_new_balance, p_source, p_note, p_performed_by,
    p_stripe_session_id, p_stripe_invoice_id
  );

  return v_new_balance;
end;
$$;

-- BACKFILL: insert ledger rows from existing purchases. balance_after is
-- left NULL because historical balances can't be reconstructed without a
-- full event log. The "initial vs renewal" split for subscription rows uses
-- the earliest subscription purchase per user as the initial.
-- Idempotent: skips any purchase whose stripe_session_id or
-- stripe_invoice_id is already in credit_transactions.
insert into credit_transactions (
  user_id, amount, balance_after, source, note,
  stripe_session_id, stripe_invoice_id, created_at
)
select
  p.user_id,
  p.credits_purchased,
  null,
  case
    when p.package_name = 'subscription' then
      case
        when p.created_at = (
          select min(p2.created_at) from purchases p2
          where p2.user_id = p.user_id and p2.package_name = 'subscription'
        ) then 'subscription_initial'
        else 'subscription_renewal'
      end
    else 'bundle_purchase'
  end,
  'Backfilled from purchases table',
  p.stripe_session_id,
  p.stripe_invoice_id,
  p.created_at
from purchases p
where not exists (
  select 1 from credit_transactions ct
  where (ct.stripe_session_id is not null and ct.stripe_session_id = p.stripe_session_id)
     or (ct.stripe_invoice_id is not null and ct.stripe_invoice_id = p.stripe_invoice_id)
);
