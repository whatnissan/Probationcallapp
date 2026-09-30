-- 063: repair migration 062's phase backfill.
--
-- 062 derived call_history.phases from daily_county_status.color by splitting
-- on commas and stripping the leading word:
--     trim(regexp_replace(p, '^[Pp]hase[[:space:]]*', ''))
-- The parts after the first arrive with a LEADING SPACE (" Phase 3"), so the
-- ^ anchor did not match and the word survived. The trim ran afterwards and
-- removed only the outer space. Result: ["1 B","Phase 3"] where the contract
-- (§4.11) and every client expect ["1 B","3"]. The first element was always
-- right, which is exactly why it read as correct at a glance.
--
-- The application code was never wrong — lib/ftbend.classifyAnswer trims each
-- part BEFORE stripping, and its tests cover 'Phase 1 B, Phase 5'. This is a
-- one-off repair of rows written by the backfill, and it re-derives from the
-- office's own record rather than trying to patch the strings in place.
--
-- Also: 062 filled the announcement on NO_CREDITS rows, where no call was
-- ever placed. What the office announced that day is true but it is not this
-- row's fact — the row means "we did not call" — so those are cleared.
--
-- Idempotent: re-deriving is the same operation twice, and the NO_CREDITS
-- clear is a no-op the second time. Safe to run any time; no deploy ordering.

WITH src AS (
  SELECT ch.id,
         dcs.color AS answer
  FROM call_history ch
  JOIN daily_county_status dcs
    ON dcs.county = 'ftbend_' || ch.ftbend_office
   AND dcs.date = (ch.created_at AT TIME ZONE 'America/Chicago')::date
  WHERE ch.county = 'ftbend'
    AND ch.phases IS NOT NULL
    AND dcs.color IS NOT NULL
    AND dcs.color <> 'UNKNOWN'
)
UPDATE call_history ch
SET phases = (
      SELECT jsonb_agg(v ORDER BY ord)
      FROM (
        SELECT trim(regexp_replace(trim(p), '^[Pp]hase[[:space:]]*', '')) AS v, ord
        FROM unnest(string_to_array(src.answer, ',')) WITH ORDINALITY AS t(p, ord)
      ) parts
      WHERE v <> ''
    )
FROM src
WHERE ch.id = src.id;

-- A skipped call announced nothing: the row's fact is that we did not call.
UPDATE call_history
SET announced = NULL, phases = NULL
WHERE county = 'ftbend'
  AND result = 'NO_CREDITS'
  AND (announced IS NOT NULL OR phases IS NOT NULL);

INSERT INTO schema_migrations (filename, note)
VALUES ('063_fix_phase_backfill.sql', 'repair 062: leading space left "Phase" on parts after the first; clear announcement on NO_CREDITS rows')
ON CONFLICT (filename) DO NOTHING;
