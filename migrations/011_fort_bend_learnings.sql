-- migrations/011_fort_bend_learnings.sql
-- Log every Fort Bend call's detection vs ground-truth comparison so we can
-- review weekly and codify recurring misrecognitions as permanent entries in
-- FTBEND_MISRECOGNITIONS. One row per call attempt.
--
-- match_method tells us HOW we arrived at the final answer:
--   'detection_already_correct' — our_detection matched ground truth on
--                                 first pass; no learning needed.
--   'substring'         — ground truth appeared verbatim in transcript.
--                         (e.g., we mis-detected but transcript actually
--                         contained the right word — the parser missed it.)
--   'phonetic'          — ground truth sounded like a token in transcript;
--                         the matched token was auto-added to the in-memory
--                         FTBEND_MISRECOGNITIONS map for the rest of today.
--                         (e.g., transcript had "moca", ground truth was
--                         "Mocha".)
--   'no_match'          — neither substring nor phonetic match found. Call
--                         likely failed entirely. Retry queued in Commit B.
--   'no_ground_truth'   — finishprobation.com hadn't published today's data
--                         at attempt time. Retry queued in Commit B.
--
-- service_role only per the day's RLS lockdown pattern. anon and
-- authenticated have no grants. SERVICE_KEY bypasses RLS for server writes.

create table if not exists fort_bend_learnings (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  office text not null,
  hotline_number text not null,
  raw_transcript text,
  our_detection text,
  ground_truth text,
  match_method text,
  misrecognition_added text,
  attempt_number int not null default 1,
  created_at timestamptz default now()
);

create index if not exists fort_bend_learnings_date_office_idx
  on fort_bend_learnings (date desc, office);

alter table fort_bend_learnings enable row level security;

revoke all on table fort_bend_learnings from anon;
revoke all on table fort_bend_learnings from authenticated;
grant select, insert, update, delete on table fort_bend_learnings to service_role;
