-- Migration: enforce one redemption per user per promo code at the DB
-- level. /api/redeem's check-then-insert had a race window where two
-- concurrent requests could both pass the "already used" select and both
-- redeem; with this index the second insert fails and the server returns
-- "Already used" before any credit is granted (server.js /api/redeem
-- checks the insert error).
--
-- Idempotent: IF NOT EXISTS. If existing data already contains duplicate
-- (user_id, promo_code_id) pairs this will abort — dedupe first:
--   select user_id, promo_code_id, count(*) from promo_redemptions
--   group by 1, 2 having count(*) > 1;

create unique index if not exists promo_redemptions_user_promo_uniq
  on promo_redemptions (user_id, promo_code_id);
