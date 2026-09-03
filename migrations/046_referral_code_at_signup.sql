-- 046: a referral code from the first moment.
--
-- GET /referral returned null for a brand-new account and the app decoded
-- the code as required, so the Earn tab failed for every new user. The code
-- was assigned lazily by the app's bootstrap paths — which, since the
-- auth.users trigger creates the profile first, never ran (same root cause
-- as migration 044). Assign it where the profile is born: in the trigger.
-- Same shape the app has always generated (6 chars, no 0/O/1/I), enforced
-- unique by migration 008.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code  text;
  i     integer;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..6 LOOP
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = code);
  END LOOP;
  RETURN code;
END;
$$;

-- handle_new_user, as in 044, plus the referral code and the affiliate
-- counters the app's own insert has always set.
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
  INSERT INTO public.profiles (id, email, credits, referral_code, affiliate_balance_cents, affiliate_total_earned_cents)
  VALUES (NEW.id, NEW.email, 0, public.generate_referral_code(), 0, 0)
  ON CONFLICT (id) DO NOTHING;

  v_amount := COALESCE((SELECT (value #>> '{}')::int FROM public.app_settings WHERE key = 'starter_credits'), 5);

  IF NEW.email IS NOT NULL THEN
    v_hash := encode(digest(lower(trim(NEW.email)), 'sha256'), 'hex');
    SELECT EXISTS (SELECT 1 FROM public.deleted_account_tombstones t WHERE t.email_hash = v_hash) INTO v_tomb;
  END IF;

  IF v_tomb THEN
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

-- Backfill: every existing profile without a code gets one.
UPDATE public.profiles SET referral_code = public.generate_referral_code() WHERE referral_code IS NULL;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('046_referral_code_at_signup.sql')
ON CONFLICT (filename) DO NOTHING;
