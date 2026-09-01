-- 039: push delivery + acknowledgement state, and the SMS fallback queue.
--
-- Migration 037 records WHO to push to. This records WHAT HAPPENED to a push,
-- which is what the "push first, SMS if unread after N minutes" rule actually
-- runs on: something has to remember that a push went out at 05:06, was never
-- opened, and therefore owes an SMS at 05:16.
--
-- UNIQUE (user_id, local_date) is the safety property that matters. It makes a
-- morning's delivery record singular, so a retried notify, a double webhook, or
-- a poller running twice cannot queue two fallbacks and text somebody twice
-- about the same result. Bill-once discipline, applied to delivery.
--
-- Three ways a fallback becomes due, and they are deliberately distinguished:
--   'unread'      — push delivered, nobody opened it before the timer expired
--   'send_failed' — APNs rejected the send (dead token, bad payload)
--   'no_device'   — the user has no live token at all
-- send_failed and no_device fall back IMMEDIATELY rather than waiting out the
-- timer: if we already know push failed, making someone wait ten minutes for
-- a MUST_TEST is gambling with the one thing this service exists to deliver.
--
-- Locked down like every other table (the lesson from 035).
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS push_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  -- The morning this belongs to, in the USER's timezone — not UTC, or a
  -- 5 AM CST call lands on the previous or next date depending on the season.
  local_date       date NOT NULL,
  -- What we told them. Quiet-mode users only ever get MUST_TEST here.
  result           text NOT NULL,
  call_id          uuid,
  token            text,
  -- APNs apns-id, so a delivery can be correlated with Apple's own logs.
  apns_id          text,
  sent_at          timestamptz,
  send_failed_at   timestamptz,
  send_error       text,
  -- Set when the device reports the notification was opened (§4.12a ack).
  acked_at         timestamptz,
  fallback_due_at  timestamptz,
  fallback_sent_at timestamptz,
  fallback_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One delivery record per user per morning. This is what prevents a double SMS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_deliveries_user_day
  ON push_deliveries(user_id, local_date);

-- The poller's query: what is due, still unacknowledged, and not yet sent.
CREATE INDEX IF NOT EXISTS idx_push_deliveries_due
  ON push_deliveries(fallback_due_at)
  WHERE fallback_sent_at IS NULL AND acked_at IS NULL AND fallback_due_at IS NOT NULL;

ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_fallback_reason_check;
ALTER TABLE push_deliveries
  ADD CONSTRAINT push_deliveries_fallback_reason_check
  CHECK (fallback_reason IS NULL OR fallback_reason IN ('unread', 'send_failed', 'no_device'));

COMMENT ON TABLE push_deliveries IS
  'One row per user per morning recording the push and whether it was opened. Drives the unread-then-SMS fallback; unique on (user_id, local_date) so a morning can never produce two fallback texts.';

REVOKE ALL ON push_deliveries FROM anon, authenticated;
ALTER TABLE push_deliveries ENABLE ROW LEVEL SECURITY;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('039_push_deliveries.sql')
ON CONFLICT (filename) DO NOTHING;
