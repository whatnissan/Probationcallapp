-- 062: the Fort Bend announcement as DATA on the call row, plus the alias
--      the Sep 17 "Ping" miss needed.
--
-- Two bugs, one root: the announcement existed only as a formatted string.
--
-- 1. The per-user row chose its format from the OFFICE (has_phases on the
--    office config), not from what was announced, so a Rosenberg 2 colour
--    day was written 'P1:Gray P2:?' — five days in September. The county
--    status writer classified by VALUE and got the same day right, which is
--    why the office board showed Gray while the subscriber's row showed a
--    question mark.
--
-- 2. Reading that string back was done with a regex whose capture stopped at
--    the next capital P, so 'P1:Phase 1 b P2:Phase 3' parsed to an EMPTY
--    list and the row summary said "Nothing announced" on a genuine phase
--    day — a wrong message to a subscriber — while 'P1:Gray P2:?' parsed to
--    ['Gray', '?'] and put a literal '?' where the contract promises a
--    colour or a phase group.
--
-- So the row now carries the announcement as data: `announced` (colours) or
-- `phases` (groups), mutually exclusive exactly as §4.1 and §4.11 define
-- them, written by ONE classifier shared with the office board. The string in
-- `result` stays as it is — it is what a subscriber has already been shown,
-- and rewriting delivered history to look tidier is not a fix (Dave's call).
-- Nothing re-parses it when these columns are present.
--
-- jsonb arrays, not text[]: it is what goes on the wire, and a null stays
-- distinguishable from an empty array — null means "we never recorded the
-- announcement for this row", [] would claim the hotline announced nothing.
--
-- Safe to re-run. Run BEFORE the deploy: the result path writes these
-- columns. Supabase SQL editor, tracking insert in the same session.

ALTER TABLE call_history
  ADD COLUMN IF NOT EXISTS announced jsonb,
  ADD COLUMN IF NOT EXISTS phases    jsonb;

COMMENT ON COLUMN call_history.announced IS
  'Colours the office announced that morning, lowercase, as a jsonb array (§4.1). Mutually exclusive with phases. NULL = not recorded for this row (every Montgomery row, and Fort Bend rows written before migration 062).';
COMMENT ON COLUMN call_history.phases IS
  'Phase groups the office announced, "Phase " stripped, as a jsonb array (§4.11). Mutually exclusive with announced. NULL = not recorded for this row.';

-- The alias the catalogue was missing. On 2026-09-17 Rosenberg announced
-- Pink, Deepgram heard "Ping", and detection returned nothing — the colour
-- field was only right because the cross-check fell back to
-- finishprobation.com, i.e. the backup site covered a gap in our own
-- vocabulary. Catalogue row, not a code change (migration 040's whole point).
INSERT INTO ftbend_color_aliases (alias, color_name, note)
VALUES ('ping', 'pink', 'Deepgram heard "Ping" for Pink — Rosenberg, 2026-09-17; detection returned null and the cross-check saved it from finishprobation')
ON CONFLICT (alias) DO NOTHING;

-- Backfill from the office's own record. daily_county_status holds the
-- cross-checked answer per office per day, so every Fort Bend call row that
-- has a matching status row gets its announcement filled in. This ADDS the
-- structured meaning; it does not touch `result`.
--
-- Phase days: the answer reads "Phase 1 B, Phase 5" — split on commas and
-- strip the word, giving ["1 B","5"], the §4.11 shape.
-- Colour days: one lowercase element, the §4.1 shape.
WITH src AS (
  SELECT ch.id,
         dcs.color AS answer,
         (dcs.color ILIKE 'phase%' OR dcs.phase1_color ILIKE 'phase%' OR dcs.phase2_color ILIKE 'phase%') AS is_phases
  FROM call_history ch
  JOIN daily_county_status dcs
    ON dcs.county = 'ftbend_' || ch.ftbend_office
   AND dcs.date = (ch.created_at AT TIME ZONE 'America/Chicago')::date
  WHERE ch.county = 'ftbend'
    AND ch.ftbend_office IS NOT NULL
    AND dcs.color IS NOT NULL
    AND dcs.color <> 'UNKNOWN'
    AND ch.announced IS NULL
    AND ch.phases IS NULL
)
UPDATE call_history ch
SET announced = CASE WHEN src.is_phases THEN NULL ELSE to_jsonb(ARRAY[lower(trim(src.answer))]) END,
    phases    = CASE WHEN src.is_phases THEN (
                  SELECT jsonb_agg(v ORDER BY ord)
                  FROM (
                    SELECT trim(regexp_replace(p, '^[Pp]hase[[:space:]]*', '')) AS v, ord
                    FROM unnest(string_to_array(src.answer, ',')) WITH ORDINALITY AS t(p, ord)
                  ) parts
                  WHERE v <> ''
                ) ELSE NULL END
FROM src
WHERE ch.id = src.id;

INSERT INTO schema_migrations (filename, note)
VALUES ('062_call_history_announcement.sql', 'call_history.announced/phases + ping->pink alias + backfill from daily_county_status')
ON CONFLICT (filename) DO NOTHING;
