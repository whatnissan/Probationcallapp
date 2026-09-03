-- Migration: server-driven office directory (API_CONTRACT §4.18).
--
-- WHY: the iOS office directory is hardcoded Swift constants
-- (MontgomeryOffices.swift). Correcting a set of hours needs a full App
-- Store release, and never reaches anyone who does not update. The failure
-- this prevents: hours change, the app confidently shows the old ones, and
-- someone drives to a closed office and misses a test.
--
-- THIS IS PUBLIC FACILITY INFORMATION, NOT LOCATION DATA. These are county
-- probation office addresses published by the county on its own client
-- instruction forms. The system still holds no location data about any
-- user. §4.2's rule is unchanged: a history row names a county or an
-- office, never a city. The direction of the fact is what matters — this
-- says where the county's building is; nothing anywhere says where the
-- user is.
--
-- THE PROPERTY THAT MUST SURVIVE: a county with NO office rows has no
-- verified directory, and the client falls back to a Maps SEARCH via
-- office_counties.maps_query rather than pinning an address. That is
-- deliberate (OfficeDirectory.swift): "the app doesn't vouch for a
-- building it can't verify, and a wrong address sends someone on probation
-- to the wrong place." Fort Bend gets its county row and NO office rows,
-- because its form has not arrived and nobody has verified its addresses.
-- Do not seed addresses here to make the table look complete.
--
-- HOURS SHAPE: jsonb object, lowercase weekday name -> array of
-- "HH:mm-HH:mm" open spans, matching TestingOffice.OpenSpan exactly so the
-- app parses nothing new. A MISSING WEEKDAY MEANS CLOSED THAT DAY (New
-- Caney's Monday closure is Monday's absence). TWO SPANS ON A DAY IS A
-- LUNCH CLOSURE (New Caney, 11:00-12:00). Hours are local to the office in
-- the county's own time zone, never the phone's.
--
-- Seed values are copied verbatim from
-- ~/Documents/Probationcall/Probationcall/Features/Today/MontgomeryOffices.swift,
-- the verified source of truth against the county's form. The lunch note
-- uses an EN DASH (U+2013), as the app does.
--
-- No RLS policies: these tables hold zero user data, the server reads them
-- with the service key, and the endpoint serving them is public anyway.
-- RLS is enabled with no policy so anon/authenticated get nothing through
-- PostgREST directly.
--
-- EIGHT statements, one per block — run them one at a time, in order.
-- Statement 7 (offices) has a foreign key onto statement 6's rows, so the
-- county insert must land first.

create table if not exists office_counties (
  county           text primary key,
  time_zone        text        not null,
  assignment_rule  text,
  maps_query       text,
  updated_at       timestamptz not null default now()
);

create table if not exists offices (
  id          text primary key,
  county      text        not null references office_counties (county),
  name        text        not null,
  street      text        not null,
  city_line   text        not null,
  phone       text,
  hours       jsonb       not null default '{}'::jsonb,
  notes       jsonb       not null default '[]'::jsonb,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  updated_at  timestamptz not null default now()
);

create index if not exists idx_offices_county_order on offices (county, sort_order) where is_active;

alter table office_counties enable row level security;

alter table offices enable row level security;

insert into office_counties (county, time_zone, assignment_rule, maps_query) values ('montgomery', 'America/Chicago', 'Test only at the office you''re assigned to. Check with your officer if you''re not sure.', 'Montgomery County Community Supervision and Corrections Department, Conroe, TX'), ('ftbend', 'America/Chicago', null, 'Fort Bend County Community Supervision and Corrections Department, Missouri City, TX') on conflict (county) do nothing;

insert into offices (id, county, name, street, city_line, phone, hours, notes, sort_order) values ('conroe', 'montgomery', 'RMS Conroe Office', '310 East Davis Street, Suite 100', 'Conroe, TX 77301', '(936) 207-4223', '{"monday":["08:00-17:45"],"tuesday":["08:00-17:45"],"wednesday":["08:00-17:45"],"thursday":["08:00-17:45"],"friday":["08:00-17:45"],"saturday":["08:00-15:00"]}'::jsonb, '["Saturday: Conroe only, and only if you''re required to test that day."]'::jsonb, 0), ('new-caney', 'montgomery', 'New Caney Office', '21134 US Hwy 59', 'New Caney, TX 77357', '(281) 577-8996', '{"tuesday":["07:00-11:00","12:00-15:45"],"wednesday":["07:00-11:00","12:00-15:45"],"thursday":["07:00-11:00","12:00-15:45"],"friday":["07:00-11:00","12:00-15:45"]}'::jsonb, '["Closed Mondays.","Closed 11:00 AM – 12:00 PM for lunch."]'::jsonb, 1) on conflict (id) do nothing;

insert into schema_migrations (filename) values ('049_office_directory.sql') on conflict (filename) do nothing;
