-- 052: sum the credit ledger in Postgres, not in Node.
--
-- The daily integrity digest (044) paged the WHOLE credit_transactions
-- table into the app every morning to sum it per user — a full-table read
-- whose cost grows with all history ever written. 388 rows today, ~62,000
-- a year at 200 subscribers, and it never gets faster. This function
-- returns one row per user with a ledger, so the digest is bounded by the
-- number of profiles instead of the length of the ledger, forever.
--
-- SECURITY DEFINER because the ledger is locked to the service role (the
-- 035 discipline); EXECUTE is revoked from anon and authenticated so the
-- only caller is the server through rpc('ledger_sums'). STABLE: reads only.
--
-- No new index. credit_transactions_user_id_idx (002) is on
-- (user_id, created_at desc) and a GROUP BY user_id uses its leading
-- column; a second index on (user_id) alone would be the duplicate-index
-- mistake this same audit is removing from profiles.referral_code.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE OR REPLACE FUNCTION ledger_sums()
RETURNS TABLE (user_id uuid, ledger_sum bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id, COALESCE(SUM(amount), 0)::bigint AS ledger_sum
  FROM credit_transactions
  GROUP BY user_id
$$;

REVOKE EXECUTE ON FUNCTION ledger_sums() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION ledger_sums() IS
  'Per-user sum of credit_transactions.amount for the daily integrity digest. Service role only; replaces paging the whole ledger into the app.';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('052_ledger_sums.sql')
ON CONFLICT (filename) DO NOTHING;
