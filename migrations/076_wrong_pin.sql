-- 076: WRONG_PIN — the hearings it is decided from, and the count that
-- pauses on it.
--
-- 2026-10-28 (Dave's ruling). WRONG_PIN is now produced: the Montgomery
-- hotline asks for the ID number again when it rejects one, and that is
-- recognised (lib/detection.js detectPinReprompt; the rules are in
-- lib/wrong-pin.js).
--
--   user_schedules.consecutive_wrong_pin  WRONG_PIN mornings in a row on the
--     PIN on file. 2 pause the schedule as 'wrong_pin', which only a
--     DIFFERENT PIN lifts. The twin of consecutive_pin_expired, kept the same
--     way: +1 per WRONG_PIN morning, back to 0 when the PIN changes
--     (applyPauseOnSave) or a result is heard (deductCreditOnce). Call Now
--     never counts.
--
--   pin_reprompts  one row per call that heard the repeated prompt, whatever
--     was decided about it. The many-accounts guard counts DISTINCT accounts
--     here per morning: 3 or more on one morning is our fault (tones, or the
--     hotline's menu), not their PINs. Its own table because call_attempts
--     means "one row per dial" to every reader (/today's attempt count, the
--     first-day check, the dial spacing, reliability). No PIN and no
--     transcript stored. Goes with the account (ON DELETE CASCADE), like
--     schedule_pause_events. RLS on, no policies: the server reads it.
--
-- paused_reason is free text (017), so 'wrong_pin' needs no schema change.
--
-- Safe to re-run. Supabase SQL editor, one statement per block, tracking
-- insert last.

-- 076.1
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS consecutive_wrong_pin integer NOT NULL DEFAULT 0;

-- 076.2
CREATE TABLE IF NOT EXISTS pin_reprompts (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_sid      text,
  is_scheduled  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 076.3
CREATE INDEX IF NOT EXISTS pin_reprompts_created_idx ON pin_reprompts (created_at);

-- 076.4
ALTER TABLE pin_reprompts ENABLE ROW LEVEL SECURITY;

-- 076.5
INSERT INTO schema_migrations (filename, note)
VALUES ('076_wrong_pin.sql', 'user_schedules.consecutive_wrong_pin (2 pause as wrong_pin) + pin_reprompts (repeated ID prompt hearings, for the many-accounts guard)')
ON CONFLICT (filename) DO NOTHING;
