-- 058: index notification_log.provider_message_id.
--
-- Twilio message status receipts (POST /webhook/sms-status, 2026-09-15)
-- look a row up by its MessageSid on every transition — several per text,
-- twenty-odd texts a morning, more on a retry day. notification_log had no
-- index on that column because nothing ever queried it: delivery_status
-- and delivered_at were declared in 027 and never written. Partial, since
-- email rows and suppressed sends have no provider id.
--
-- Safe to re-run. Run in the Supabase SQL editor, tracking insert in the
-- same session. Can go in before or after the deploy: the webhook works
-- without it, just slower as the table grows.

CREATE INDEX IF NOT EXISTS notification_log_provider_message_id_idx
  ON notification_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

INSERT INTO schema_migrations (filename, note)
VALUES ('058_notification_log_provider_message_id_idx.sql', 'index for SMS status receipts')
ON CONFLICT (filename) DO NOTHING;
