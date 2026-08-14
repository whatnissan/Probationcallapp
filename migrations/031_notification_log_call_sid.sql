-- migrations/031_notification_log_call_sid.sql
--
-- Exact join between a notification and the call it reports on.
-- notification_log.kind holds the INTERNAL call id ('call_1786...'), which
-- is stored nowhere in call_history — so the transcribed->notified link
-- could only be joined per user per day, not per call. call_history already
-- carries the Twilio call_sid; recording it on the notification row too
-- (resolved centrally in logNotification from the in-flight call map) makes
-- the chain exact. Nullable: non-call notifications (low_credit, welcome,
-- sched, ...) have no sid.

alter table notification_log
  add column if not exists call_sid text;
