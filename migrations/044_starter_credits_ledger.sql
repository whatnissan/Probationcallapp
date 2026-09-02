-- 044: starter credits through the ledger, settings-driven; tombstone check
--      where it will actually run; reconciliation; review flags; the earned
--      extension (BUILT, HELD — earned_grant_enabled stays false).
--
-- What was found (2026-09-02): a trigger, on_auth_user_created → handle_new_user(),
-- creates every profile with credits = 5 before any app code runs. So the
-- app's bootstrap grant never ran for any signup, the 5 never reached
-- credit_transactions, the tombstone check in the app was dead on arrival,
-- and multi-email farming went straight through. Every balance in the
-- system disagreed with its ledger.
--
-- 1. app_settings — values the trigger and the app read at run time, so a
--    promotion is a row edit, not a deploy. JSON scalars.
-- 2. handle_new_user() rewritten: zero-credit profile, read starter_credits,
--    grant through add_credits_with_ledger (a plain plpgsql function, so a
--    trigger can call it), and a tombstone check that withholds the grant
--    and writes a zero-amount audit row instead.
-- 3. Reconciliation: one row per profile whose balance ≠ ledger sum, so
--    from here on sum(amount) = credits and the nightly check in server.js
--    can catch the next silent write.
-- 4. account_review_flags — shared phone / device reuse at onboarding.
--    Flag for review, never refuse (a family member managing an account is
--    legitimate; being unable to sign up is worse than someone farming).
-- 5. apply_earned_extension(uuid) — the second grant, EARNED: low balance
--    AND real billed results AND a MUST_TEST AND no unresolved flag. Gated
--    on earned_grant_enabled=false until the September paywall cohort
--    resolves (Dave's ruling: granting now would destroy the first clean
--    paywall test the product has had).
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

-- 1. settings ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_settings FROM anon, authenticated;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO app_settings (key, value, description) VALUES
  ('starter_credits', '5', 'Credits granted at signup by handle_new_user(). Edit here for a promotion; the ledger note records the value in force at the time.'),
  ('earned_grant_enabled', 'false', 'HELD (2026-09-02) until the September paywall cohort resolves. When true, apply_earned_extension() runs after every billed result.'),
  ('earned_grant_credits', '10', 'Credits added by the earned extension.'),
  ('earned_grant_balance_at_or_below', '1', 'The extension fires when a deduction leaves the balance at or below this.'),
  ('earned_grant_min_results', '5', 'Billed MUST_TEST/NO_TEST results required before the extension can fire.'),
  ('earned_grant_min_must_tests', '1', 'Billed MUST_TEST results required before the extension can fire.'),
  ('earned_grant_max_per_user', '1', 'Lifetime cap on earned extensions per account.')
ON CONFLICT (key) DO NOTHING;

-- 2. the trigger ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_amount integer;
  v_hash   text;
  v_tomb   boolean := false;
BEGIN
  -- Zero credits. The grant below is the ONLY starter grant, and it goes
  -- through the ledger. ON CONFLICT so an app-side bootstrap that raced us
  -- cannot fail the signup.
  INSERT INTO public.profiles (id, email, credits)
  VALUES (NEW.id, NEW.email, 0)
  ON CONFLICT (id) DO NOTHING;

  v_amount := COALESCE((SELECT (value #>> '{}')::int FROM public.app_settings WHERE key = 'starter_credits'), 5);

  -- Same normalisation as lib/auth.js emailTombstoneHash: trim, lowercase, sha256 hex.
  IF NEW.email IS NOT NULL THEN
    v_hash := encode(digest(lower(trim(NEW.email)), 'sha256'), 'hex');
    SELECT EXISTS (SELECT 1 FROM public.deleted_account_tombstones t WHERE t.email_hash = v_hash) INTO v_tomb;
  END IF;

  IF v_tomb THEN
    -- Withheld, and SAID so: a zero-amount row is the audit trail.
    INSERT INTO public.credit_transactions (user_id, amount, balance_after, source, note, performed_by)
    VALUES (NEW.id, 0, 0, 'signup_bonus',
            'withheld: email matches a deleted-account tombstone (starter_credits=' || v_amount || ')',
            'trigger:handle_new_user');
  ELSIF v_amount > 0 THEN
    PERFORM public.add_credits_with_ledger(
      NEW.id, v_amount, 'signup_bonus',
      'starter credits (starter_credits=' || v_amount || ')',
      'trigger:handle_new_user', NULL, NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger itself already exists (on_auth_user_created, AFTER INSERT ON
-- auth.users). Recreated here so this file is complete on its own.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. reconciliation ---------------------------------------------------------
INSERT INTO credit_transactions (user_id, amount, balance_after, source, note, performed_by)
SELECT p.id,
       p.credits - COALESCE(l.s, 0),
       p.credits,
       'reconciliation',
       'Reconciliation 2026-09-02: balance held outside the ledger (trigger-granted starter credits, direct admin updates, unbilled outage results). From this row on, sum(amount) = credits.',
       'migration_044'
FROM profiles p
LEFT JOIN (SELECT user_id, SUM(amount) AS s FROM credit_transactions GROUP BY user_id) l ON l.user_id = p.id
WHERE p.credits <> COALESCE(l.s, 0)
  AND NOT EXISTS (SELECT 1 FROM credit_transactions r WHERE r.user_id = p.id AND r.source = 'reconciliation');

-- 4. review flags -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_review_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  reason      text NOT NULL,          -- 'shared_phone' | 'device_reuse'
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text,                   -- 'legitimate' | 'farming'
  resolved_by text,
  CONSTRAINT account_review_flags_resolution_check CHECK (resolution IS NULL OR resolution IN ('legitimate', 'farming'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_review_flags_open ON account_review_flags (user_id, reason) WHERE resolved_at IS NULL;
COMMENT ON TABLE account_review_flags IS
  'Onboarding signals worth a human look (shared phone, device reuse). Never a refusal. An open flag withholds the earned extension only.';
REVOKE ALL ON account_review_flags FROM anon, authenticated;
ALTER TABLE account_review_flags ENABLE ROW LEVEL SECURITY;

-- 5. the earned extension (held) -------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_earned_extension(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s_enabled   boolean;
  s_credits   integer;
  s_threshold integer;
  s_min_res   integer;
  s_min_must  integer;
  s_max       integer;
  v_profile   profiles%ROWTYPE;
  v_results   integer;
  v_musts     integer;
  v_prior     integer;
  v_flags     integer;
BEGIN
  s_enabled := COALESCE((SELECT (value #>> '{}')::boolean FROM app_settings WHERE key = 'earned_grant_enabled'), false);
  IF NOT s_enabled THEN RETURN 0; END IF;
  s_credits   := COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'earned_grant_credits'), 10);
  s_threshold := COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'earned_grant_balance_at_or_below'), 1);
  s_min_res   := COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'earned_grant_min_results'), 5);
  s_min_must  := COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'earned_grant_min_must_tests'), 1);
  s_max       := COALESCE((SELECT (value #>> '{}')::int FROM app_settings WHERE key = 'earned_grant_max_per_user'), 1);

  SELECT * INTO v_profile FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF COALESCE(v_profile.is_demo, false) THEN RETURN 0; END IF;
  IF COALESCE(v_profile.credits, 0) > s_threshold THEN RETURN 0; END IF;

  SELECT COUNT(*) INTO v_prior FROM credit_transactions
   WHERE user_id = p_user_id AND source = 'earned_extension' AND amount > 0;
  IF v_prior >= s_max THEN RETURN 0; END IF;

  -- Real usage: BILLED results only. A farmer cannot manufacture these.
  SELECT COUNT(*) FILTER (WHERE billed_at IS NOT NULL),
         COUNT(*) FILTER (WHERE billed_at IS NOT NULL AND (result = 'MUST_TEST' OR verdict = 'MUST_TEST'))
    INTO v_results, v_musts
    FROM call_history WHERE user_id = p_user_id;
  IF v_results < s_min_res OR v_musts < s_min_must THEN RETURN 0; END IF;

  SELECT COUNT(*) INTO v_flags FROM account_review_flags WHERE user_id = p_user_id AND resolved_at IS NULL;
  IF v_flags > 0 THEN RETURN 0; END IF;

  PERFORM add_credits_with_ledger(
    p_user_id, s_credits, 'earned_extension',
    'earned extension (credits=' || s_credits || ', balance_at_or_below=' || s_threshold ||
    ', min_results=' || s_min_res || ', min_must_tests=' || s_min_must ||
    '; had results=' || v_results || ', must_tests=' || v_musts || ')',
    'function:apply_earned_extension', NULL, NULL);
  RETURN s_credits;
END;
$$;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('044_starter_credits_ledger.sql')
ON CONFLICT (filename) DO NOTHING;
