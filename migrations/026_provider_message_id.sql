-- migrations/026_provider_message_id.sql
-- Store the provider's own message id against each mass-send recipient.
--
-- Tracing the 2026-08-06 test copy required matching a Brevo event to a
-- mass_send_recipients row on subject text and a timestamp, because the id
-- Brevo returns on acceptance was being discarded. That works for one message
-- on a quiet day and stops working the moment two sends share a subject.
--
-- Brevo returns messageId on 201; Twilio returns a message SID (SMxxxx) on
-- create. One nullable column covers both — nullable because rows written
-- before this migration have no id, and because a FAILED send has no id to
-- record.
--
-- Safe to re-run.

alter table mass_send_recipients
  add column if not exists provider_message_id text;

create index if not exists mass_send_recipients_provider_msg_idx
  on mass_send_recipients (provider_message_id)
  where provider_message_id is not null;

comment on column mass_send_recipients.provider_message_id is
  'Brevo messageId or Twilio SID returned on acceptance. NULL for failed sends and for rows predating this column.';
