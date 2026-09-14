-- 055: the weekdays on which a county restricts testing to ONE office
-- (contract §4.18 soleOffice).
--
-- Until now the app decided whether to send a person to another office by
-- keyword-matching an office NOTE — "Saturday: Conroe only, and only if
-- you're required to test that day." — so a rewording silently changed
-- behaviour on the one day the county restricts testing to a single
-- building. The rule is now data: {"saturday":"conroe"}. Notes go back to
-- being display copy.
--
-- This is the COUNTY picking, relayed by the server. The app still never
-- picks an office for anyone; on a soleOffice day it shows the county's
-- exception, as it shows the county's assignment rule on every other day.
--
-- The server drops any entry whose office is inactive or has no hours on
-- that weekday: a restriction pointing at a closed or retired building is a
-- data error, never something to send.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

ALTER TABLE office_counties
  ADD COLUMN IF NOT EXISTS sole_office jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN office_counties.sole_office IS
  'Weekdays on which the county restricts testing to one office: {"saturday":"conroe"} (contract §4.18 soleOffice). Lowercase weekday keys, offices.id values. Replaces prose-matching office notes in clients. Server drops any entry whose office is inactive or closed that day.';

-- The one restriction the county publishes today. updated_at moves asOf so
-- clients holding a cached directory refresh it.
UPDATE office_counties
SET sole_office = '{"saturday":"conroe"}'::jsonb, updated_at = now()
WHERE county = 'montgomery';

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('055_sole_office.sql')
ON CONFLICT (filename) DO NOTHING;
