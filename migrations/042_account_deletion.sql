-- 042: DELETE /account (§4.15, App Store 5.1.1(v)).
--
-- Two things the endpoint needs from the schema.
--
-- 1. A tombstone for deleted emails. Deleting the auth user frees the
--    address, and both bootstrap paths grant starter credits to a profile
--    they have never seen — so delete, re-register, repeat would farm
--    credits. We store a SHA-256 of the normalised email, never the address:
--    the point of deletion is that we no longer hold it.
--
-- 2. Nullable references on the rows that are KEPT after deletion (Dave's
--    rulings, 2026-09-02): purchases are anonymised, not deleted (Stripe ids
--    and amounts stay for chargeback defence); sms_consents keep the phone
--    and timestamp as TCPA evidence with user_id nulled; affiliate_earnings
--    and referrals where the deleted person was the REFERRED party stay,
--    because they are somebody else's money, with the reference nulled.
--    DROP NOT NULL is a no-op if the column is already nullable.
--
-- FK audit (Dave, 2026-09-02, pg_constraint against profiles):
--   cascade:   call_history, purchases, promo_redemptions, user_schedules,
--              credit_transactions, support_messages
--   no action: referrals (both columns), affiliate_earnings, payout_requests
--   set null:  sms_opt_outs, mass_send_recipients, notification_log
--   none:      sms_consents
-- purchases CASCADE contradicts the retain-anonymised ruling, so this file
-- rewrites that constraint to ON DELETE SET NULL (the block below finds it by
-- column, whatever it is named). credit_transactions stays CASCADE by
-- decision: the ledger is personal financial detail with no external
-- defence value, and the endpoint deletes it explicitly anyway. The NO
-- ACTION references are nulled or deleted by the endpoint BEFORE the
-- profile row goes; if one is missed the profile delete is refused and the
-- endpoint returns 409 account_deletion_blocked, never a half-deleted auth.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
  email_hash text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE deleted_account_tombstones IS
  'SHA-256 of the normalised email of every deleted account. A re-signup that matches gets a profile but no starter credits.';
REVOKE ALL ON deleted_account_tombstones FROM anon, authenticated;
ALTER TABLE deleted_account_tombstones ENABLE ROW LEVEL SECURITY;

ALTER TABLE purchases          ALTER COLUMN user_id     DROP NOT NULL;

-- purchases.user_id → profiles: CASCADE becomes SET NULL. Looked up by
-- column so the constraint's name does not matter; no-op if already SET NULL.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname, con.confdeltype
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'purchases'::regclass
      AND con.confrelid = 'profiles'::regclass
      AND att.attname = 'user_id'
  LOOP
    IF c.confdeltype <> 'n' THEN
      EXECUTE format('ALTER TABLE purchases DROP CONSTRAINT %I', c.conname);
      EXECUTE format('ALTER TABLE purchases ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL', c.conname);
      RAISE NOTICE 'purchases.%: rewritten to ON DELETE SET NULL', c.conname;
    END IF;
  END LOOP;
END $$;
ALTER TABLE sms_consents       ALTER COLUMN user_id     DROP NOT NULL;
ALTER TABLE affiliate_earnings ALTER COLUMN referred_id DROP NOT NULL;
ALTER TABLE referrals          ALTER COLUMN referred_id DROP NOT NULL;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('042_account_deletion.sql')
ON CONFLICT (filename) DO NOTHING;
