-- Migration: register two new call_history.result values used by the
-- Gap 1 (Twilio terminal failure) and Gap 3 (empty-transcript exhaustion)
-- fixes.
--
-- New values written by the application:
--   'CALL_FAILED'   — Twilio status callback returned a terminal failure
--                     (failed / no-answer / busy / canceled). No audio
--                     captured, no transcription. billed_at NULL.
--   'HOTLINE_DOWN'  — Deepgram returned empty transcripts on all 3 attempts.
--                     Hotline likely down or recording broken. billed_at NULL.
--
-- call_history.result is plain text with no CHECK constraint at time of
-- writing (verified: production has 25 distinct values including dynamic
-- 'COLOR:Tan' etc., which a strict enum would have rejected). This
-- migration is a defensive detector — it raises a loud exception if a
-- CHECK constraint has been added since, with instructions to extend it.
-- Otherwise it's a clean no-op.

do $$
declare
  cc_name text;
  cc_def text;
begin
  select conname, pg_get_constraintdef(oid)
    into cc_name, cc_def
  from pg_constraint
  where contype = 'c'
    and conrelid = 'public.call_history'::regclass
    and pg_get_constraintdef(oid) ilike '%result%';

  if cc_name is not null then
    raise exception
      'A CHECK constraint named "%" exists on call_history.result. You must drop and recreate it to include CALL_FAILED and HOTLINE_DOWN. Current definition: %',
      cc_name, cc_def;
  end if;

  raise notice 'No CHECK constraint on call_history.result — no schema change needed for the new values';
end $$;
