-- 069: Conroe's Saturday hours are 08:00–12:00, not 08:00–15:00.
--
-- Dave was told (2026-10-06) the Conroe office closes at noon on Saturday.
-- Neither time can be verified online; he is confirming by phone. Until
-- then the earlier close is the safe one: showing noon when it is really
-- 3 PM costs nobody anything, but showing 3 PM when it is really noon can
-- send someone to a locked door on a test day — and on Saturday Conroe is
-- the ONLY office (soleOffice), and the app computes the day's deadline from
-- these hours.
--
-- Where 15:00 came from: migration 049 copied every value verbatim from the
-- iOS app's Shared/MontgomeryOffices.swift, whose header cites "the county's
-- own client instruction form". It entered that file in iOS commit 0463dab
-- (2026-09-02) and was never independently re-checked.
--
-- updated_at moves the directory's asOf (lib/offices.shapeDirectory takes
-- the newest updated_at), which is how clients see the directory changed.
-- The response carries Cache-Control max-age=86400, so a client may hold the
-- old copy for up to a day.
--
-- soleOffice {"saturday":"conroe"} still resolves: the server keeps an entry
-- only while the named office is active AND has hours that weekday, and it
-- still does. The note "Saturday: Conroe only, and only if you're required
-- to test that day." states no hours, so it stays as it is.
--
-- Idempotent: the row changes only while Saturday is not already noon, so a
-- re-run does not move asOf again.

UPDATE offices
SET hours = jsonb_set(hours, '{saturday}', '["08:00-12:00"]'::jsonb),
    updated_at = now()
WHERE id = 'conroe'
  AND county = 'montgomery'
  AND hours->'saturday' IS DISTINCT FROM '["08:00-12:00"]'::jsonb;

INSERT INTO schema_migrations (filename, note)
VALUES ('069_conroe_saturday_hours.sql', 'Conroe Saturday 08:00-12:00 (was 08:00-15:00, unverified; safer close until Dave confirms by phone); updated_at moves asOf')
ON CONFLICT (filename) DO NOTHING;
