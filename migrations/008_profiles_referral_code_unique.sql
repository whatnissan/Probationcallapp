-- Migration: enforce UNIQUE on profiles.referral_code so the affiliate
-- commission resolver can never silently attribute a sale to the wrong
-- profile when two users happen to share a code.
--
-- Codes are normalized to uppercase by the application (server.js
-- resolveAffiliateByCode and every writer), so a plain UNIQUE constraint
-- is sufficient — no functional-index normalization needed.
--
-- Postgres UNIQUE treats multiple NULLs as distinct, so existing NULL
-- referral_code rows are fine and don't need to be cleaned up.
--
-- Idempotent: skipped if the constraint already exists. Aborts loudly
-- (with the list of conflicting codes) if existing data has duplicates —
-- this prevents the constraint silently failing to apply, or applying
-- partially.
--
-- If the abort triggers: run the diagnostic SELECT in the exception
-- message to find the duplicated codes, decide which profile keeps the
-- code (NULL out the others or assign new codes), then re-run this
-- migration.

do $$
declare
  dup_count int;
  dup_list text;
begin
  -- 1. Skip if already applied.
  if exists (
    select 1 from pg_constraint
    where conname = 'profiles_referral_code_unique'
  ) then
    raise notice 'profiles_referral_code_unique already exists — skipping';
    return;
  end if;

  -- 2. Abort with a diagnostic message if there are existing duplicates.
  select
    count(*),
    string_agg(referral_code || ' (' || cnt || ' profiles)', ', ')
  into dup_count, dup_list
  from (
    select referral_code, count(*) as cnt
    from profiles
    where referral_code is not null
    group by referral_code
    having count(*) > 1
  ) sub;

  if dup_count > 0 then
    raise exception
      'Cannot add UNIQUE constraint: % duplicate referral_code value(s) exist: %. Dedupe before re-running. Diagnostic: select referral_code, count(*), array_agg(id::text) from profiles where referral_code is not null group by referral_code having count(*) > 1;',
      dup_count, dup_list;
  end if;

  -- 3. Apply the constraint.
  alter table profiles
    add constraint profiles_referral_code_unique unique (referral_code);
end $$;
