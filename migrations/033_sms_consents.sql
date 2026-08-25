-- migrations/033_sms_consents.sql
--
-- A2P proof of SMS opt-in. Until now the consent checkbox (added c13f6c3,
-- 2025-12-02) was validated in the browser and never persisted — a Twilio
-- audit would have found no record that any user ever consented, to which
-- wording, when, or from where. Additionally the client check tested
-- method === 'sms' only, so 'both' (a majority of active schedules) was
-- never gated at all, and nothing was enforced server-side.
--
-- APPEND-ONLY table, deliberately not columns on user_schedules: consent
-- proof must survive schedule deletion and number changes (audits concern
-- messages already sent). One row per consent event; never updated, never
-- deleted. source: 'schedule_save' | 'onboarding' | 'manual_call' |
-- 'reconfirm_prompt'. consent_text_version pins WHICH wording was agreed
-- to (versions live as constants in server.js next to the exact text).
--
-- service_role only per the standing RLS lockdown pattern.

create table if not exists sms_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  phone text not null,
  consented_at timestamptz not null default now(),
  ip text,
  consent_text_version text not null,
  source text not null
);

create index if not exists sms_consents_user_idx
  on sms_consents (user_id, consented_at desc);

alter table sms_consents enable row level security;

revoke all on table sms_consents from anon;
revoke all on table sms_consents from authenticated;
