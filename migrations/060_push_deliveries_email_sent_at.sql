-- 060: push_deliveries.email_sent_at — the email no longer waits on the push ack.
--
-- Push replaced BOTH channels for a method-both user: the email sat behind
-- the same PUSH_SMS_FALLBACK_MINUTES timer as the SMS, so a person who did
-- not open the notification got their email ten minutes late for no reason.
-- The grace period exists to avoid a push AND a text for the same result;
-- an email alongside a push is not that duplication. From the deploy that
-- follows, the email goes out the moment Apple accepts the push, and only
-- the SMS waits.
--
-- This column records that send so the fallback sweep knows what is still
-- owed: set → SMS only (or nothing, for an email-only schedule); null →
-- everything, which covers rows written before this deploy and the case
-- where the immediate email failed (Brevo down) — the sweep then sends it
-- at fallback time, as it always did.
--
-- Safe to re-run. Can go before or after the deploy: the old code never
-- reads it, and the new code treats null as "not sent yet".

ALTER TABLE push_deliveries
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;

COMMENT ON COLUMN push_deliveries.email_sent_at IS
  'When the result email went out alongside the push (migration 060). Null = not sent yet, and the fallback sweep sends it with whatever else is owed.';

INSERT INTO schema_migrations (filename, note)
VALUES ('060_push_deliveries_email_sent_at.sql', 'email no longer held on the push ack')
ON CONFLICT (filename) DO NOTHING;
