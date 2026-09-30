-- 064: move Fort Bend schedules stored below §4.7's 05:10 floor up to 05:10.
--
-- v1 PUT /schedule refuses a Fort Bend callTime before 05:10 (§4.7,
-- 2026-09-02), and PUT is a full replace: the app sends the stored time back
-- with every save. So a schedule stored at 05:05 refused EVERY save, naming
-- callTime, from every build — those subscribers could not change how they
-- are told or their end date at all. Found by iOS on 2026-09-30.
--
-- The website made them: its Fort Bend pickers offer 5:00 and 5:05, and its
-- writer (POST /api/schedule) has no Fort Bend floor. Close that FIRST, or
-- new rows below the floor keep arriving after this runs (re-running this is
-- safe if any do).
--
-- The office call runs at 5:05 regardless. On a Fort Bend schedule hour and
-- minute are only when the subscriber is told, and a time that has already
-- passed when the result lands means "send now". Moving 05:05 to 05:10
-- delays a message by at most five minutes, and only on mornings the result
-- is ready before 05:10.
--
-- Rollback: every original time is kept in ftbend_time_floor_064 (service
-- role only). To undo:
--   UPDATE user_schedules s SET hour = b.old_hour, minute = b.old_minute
--   FROM ftbend_time_floor_064 b WHERE s.id = b.schedule_id;
--
-- user_schedules predates this directory, so its column types are not
-- written down here; the backup table copies them (CREATE TABLE AS ... WHERE
-- false) rather than guessing. updated_at is maintained by 057's trigger.
--
-- Idempotent: a schedule already backed up is not backed up again (its first
-- original time is the one kept), and the UPDATE matches nothing once every
-- row is at or above the floor. No deploy ordering beyond "website floor
-- first"; safe any time of day.

CREATE TABLE IF NOT EXISTS ftbend_time_floor_064 AS
SELECT id AS schedule_id, user_id, hour AS old_hour, minute AS old_minute, now() AS moved_at
FROM user_schedules
WHERE false;

REVOKE ALL ON ftbend_time_floor_064 FROM anon, authenticated;
ALTER TABLE ftbend_time_floor_064 ENABLE ROW LEVEL SECURITY;

INSERT INTO ftbend_time_floor_064 (schedule_id, user_id, old_hour, old_minute, moved_at)
SELECT s.id, s.user_id, s.hour, s.minute, now()
FROM user_schedules s
WHERE s.county = 'ftbend'
  AND (s.hour < 5 OR (s.hour = 5 AND s.minute < 10))
  AND NOT EXISTS (SELECT 1 FROM ftbend_time_floor_064 b WHERE b.schedule_id = s.id);

UPDATE user_schedules
SET hour = 5, minute = 10
WHERE county = 'ftbend'
  AND (hour < 5 OR (hour = 5 AND minute < 10));

INSERT INTO schema_migrations (filename, note)
VALUES ('064_ftbend_time_floor.sql', 'Fort Bend schedules below the 05:10 floor moved to 05:10 so v1 saves stop refusing them; originals in ftbend_time_floor_064')
ON CONFLICT (filename) DO NOTHING;
