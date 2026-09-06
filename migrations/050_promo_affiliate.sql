-- Migration: a promo code can name an affiliate (API_CONTRACT §4.14a).
-- Applied to production 2026-09-06 07:26:35 UTC.
--
-- WHY: bail bonds offices sign people up in person and enter a code at that
-- moment. Before this, promo_codes and the affiliate system shared a shape —
-- a code someone types — and nothing else. /api/redeem granted credits and
-- never touched profiles.referred_by, so an office code credited nobody. The
-- free credits are the pitch that makes a walk-in type the code; the same
-- keystroke should credit the office.
--
-- NULLABLE, AND THAT IS THE POINT. FREETRIAL and BETA10 have no affiliate
-- and keep working exactly as they do. A null affiliate_id is an ordinary
-- promo code; a set one also attributes the referral.
--
-- ON DELETE SET NULL, not CASCADE. If an affiliate's profile is deleted the
-- CODE MUST SURVIVE — people are still walking in with it printed on a card.
-- Losing the code because the affiliate closed their account would strand
-- every future redemption. Credits keep working, attribution stops, which is
-- the correct degradation.
--
-- THE REDEMPTION PATH DOES NOT FORK. POST /api/v1/redeem calls the existing
-- applyReferralForUser — the same function POST /referral/apply calls — so
-- the first-purchase window, one-code-ever, self-referral, the daily cap and
-- the review flag live in ONE function. There is no office bypass here or
-- anywhere. Presence at signup does not change who acquired an account, and
-- the window is the only defence against retroactive attribution. The web
-- and app referral paths forked once before and the web path paid commission
-- on already-purchased customers for months.
--
-- THE CAP IS PER AFFILIATE, NOT PER CODE. An office holding three codes must
-- not be able to multiply past it. 25 is deliberately generous: it does not
-- model a busy day, it bounds a bad one to a single day and surfaces it in
-- the integrity digest rather than a month later in a payout run. 0 disables.
--
-- Run in the Supabase SQL editor, one statement per block, then the tracking
-- insert IN THE SAME SESSION.

alter table promo_codes add column if not exists affiliate_id uuid references profiles(id) on delete set null;

comment on column promo_codes.affiliate_id is 'Optional affiliate credited when this code is redeemed. NULL = an ordinary promo code with no attribution. Redemption applies ORDINARY referral rules via applyReferralForUser, first-purchase window included — there is no office bypass.';

create index if not exists idx_promo_codes_affiliate on promo_codes (affiliate_id) where affiliate_id is not null;

insert into app_settings (key, value, description) values ('affiliate_max_attributions_per_day', '25'::jsonb, 'Max referral attributions one affiliate may accrue per calendar day (America/Chicago). 0 = unlimited. Over the cap the promo still grants credits; only the attribution is refused, with reason daily_cap.') on conflict (key) do nothing;

insert into schema_migrations (filename) values ('050_promo_affiliate.sql') on conflict (filename) do nothing;
