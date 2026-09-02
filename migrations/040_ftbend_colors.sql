-- 040: the Fort Bend colour catalogue, as data rather than code.
--
-- §4.11 promises "a new county color must not require an app release". Today
-- the hexes exist only in the iOS repo's CLAUDE.md, which breaks that promise
-- in both directions: the app owns domain data, and adding a colour needs a
-- release. Putting the catalogue in a table means a new colour — or a newly
-- observed misrecognition — is a row insert.
--
-- TWO tables on purpose. A colour can accumulate several misrecognitions over
-- time ("can" for cyan, "lavander" for lavender), and an aliases column would
-- either cap that at one or turn into a delimited string that needs parsing.
-- Aliases are their own rows for the same reason the hexes are: a new one
-- should be an INSERT, not a deploy.
--
-- hex is NULLABLE and that is deliberate. 31 of these names appear in real
-- production announcements and have no agreed hex yet; they render without a
-- swatch until one is supplied. A generated colour would be worse than none —
-- "Mocha" rendered as an arbitrary hash colour is invented domain data, and
-- this codebase has removed that pattern three times already.
--
-- Run in the Supabase SQL editor, then the tracking insert IN THE SAME SESSION.

CREATE TABLE IF NOT EXISTS ftbend_colors (
  -- Normalised lookup key: lowercase, trimmed. The wire/announcement form
  -- varies ("GRAY", "Gray", " gray"), the key does not.
  name         text PRIMARY KEY,
  -- What a human should see. "Gray", not "gray".
  display_name text NOT NULL,
  -- '#RRGGBB', or NULL meaning "no agreed hex — render without a swatch".
  hex          text,
  -- Prep / Prep Phase 1 / Prep Phase 2 are program designations, not colours;
  -- clients render them on a neutral slate swatch.
  is_program   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ftbend_color_aliases (
  -- Normalised misheard/variant form, e.g. 'lavander', 'can'.
  alias      text PRIMARY KEY,
  color_name text NOT NULL REFERENCES ftbend_colors(name) ON UPDATE CASCADE ON DELETE CASCADE,
  -- Why this alias exists, so a future reader does not "clean up" a real
  -- transcription artefact.
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ftbend_color_aliases_color
  ON ftbend_color_aliases(color_name);

COMMENT ON TABLE ftbend_colors IS
  'Fort Bend colour catalogue per contract §4.11 — the server owns the hex values. hex NULL means no agreed hex; clients render without a swatch and never generate one.';
COMMENT ON TABLE ftbend_color_aliases IS
  'Known misrecognitions and spelling variants mapping onto ftbend_colors.name, so a new transcription artefact is a row insert rather than a deploy.';

-- ---------------------------------------------------------------------------
-- Seed: the 17 documented colours, with the hexes from the brand palette.
-- ---------------------------------------------------------------------------
INSERT INTO ftbend_colors (name, display_name, hex, is_program) VALUES
  ('gray',      'Gray',      '#9BA1A8', false),
  ('tan',       'Tan',       '#D9B98C', false),
  ('bronze',    'Bronze',    '#C1802F', false),
  ('blue',      'Blue',      '#4A6FE8', false),
  ('canary',    'Canary',    '#F5E13C', false),
  ('ruby',      'Ruby',      '#E0264F', false),
  ('violet',    'Violet',    '#9B4DE8', false),
  ('cyan',      'Cyan',      '#4FC3D9', false),
  ('orchid',    'Orchid',    '#E87BD0', false),
  ('burgundy',  'Burgundy',  '#8A1E2E', false),
  ('aqua',      'Aqua',      '#4FF0E8', false),
  ('sapphire',  'Sapphire',  '#1E5FD9', false),
  ('apricot',   'Apricot',   '#EFA96B', false),
  ('auburn',    'Auburn',    '#8C3A1E', false),
  ('ivory',     'Ivory',     '#F0EAD6', false),
  ('chrome',    'Chrome',    '#C8CDD4', false),
  ('zinc',      'Zinc',      '#A8AEB3', false)
ON CONFLICT (name) DO NOTHING;

-- Program designations — slate swatch, never a colour.
INSERT INTO ftbend_colors (name, display_name, hex, is_program) VALUES
  ('prep',         'Prep',         NULL, true),
  ('prep phase 1', 'Prep Phase 1', NULL, true),
  ('prep phase 2', 'Prep Phase 2', NULL, true)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: names that genuinely appear in production announcements but have no
-- agreed hex. Counts are occurrences in the last 758 daily_county_status rows.
-- FILL THESE IN — most are obvious. hex NULL renders without a swatch.
-- ---------------------------------------------------------------------------
INSERT INTO ftbend_colors (name, display_name, hex, is_program) VALUES
  ('pearl',     'Pearl',     NULL, false),  -- 12
  ('iron',      'Iron',      NULL, false),  --  9
  ('mocha',     'Mocha',     NULL, false),  --  9
  ('nickel',    'Nickel',    NULL, false),  --  8
  ('amber',     'Amber',     NULL, false),  --  7
  ('brown',     'Brown',     NULL, false),  --  7
  ('turquoise', 'Turquoise', NULL, false),  --  7
  ('red',       'Red',       NULL, false),  --  7
  ('green',     'Green',     NULL, false),  --  6
  ('lemon',     'Lemon',     NULL, false),  --  6
  ('black',     'Black',     NULL, false),  --  6
  ('fuchsia',   'Fuchsia',   NULL, false),  --  5
  ('tin',       'Tin',       NULL, false),  --  5
  ('copper',    'Copper',    NULL, false),  --  5
  ('silver',    'Silver',    NULL, false),  --  5
  ('white',     'White',     NULL, false),  --  5
  ('yellow',    'Yellow',    NULL, false),  --  4
  ('pink',      'Pink',      NULL, false),  --  4
  ('peach',     'Peach',     NULL, false),  --  4
  ('maroon',    'Maroon',    NULL, false),  --  4
  ('plum',      'Plum',      NULL, false),  --  4
  ('purple',    'Purple',    NULL, false),  --  4
  ('gold',      'Gold',      NULL, false),  --  4
  ('cobalt',    'Cobalt',    NULL, false),  --  3
  ('lavender',  'Lavender',  NULL, false),  --  3
  ('orange',    'Orange',    NULL, false),  --  3
  ('emerald',   'Emerald',   NULL, false),  --  3
  ('coffee',    'Coffee',    NULL, false),  --  2
  ('olive',     'Olive',     NULL, false),  --  2
  ('tangerine', 'Tangerine', NULL, false),  --  1
  ('rose',      'Rose',      NULL, false)   --  1
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: known misrecognitions observed in production transcripts.
-- Case is handled by normalising on lookup, so 'OLIVE' needs no alias row.
-- ---------------------------------------------------------------------------
INSERT INTO ftbend_color_aliases (alias, color_name, note) VALUES
  ('lavander', 'lavender', 'Misspelling seen in hotline transcripts (1 occurrence).'),
  ('can',      'cyan',     'Speech-recognition artefact: "can" heard for "cyan". Documented in CLAUDE.md as a standing misrecognition (2 occurrences).')
ON CONFLICT (alias) DO NOTHING;

-- Locked down like every other table (the lesson from 035). The catalogue is
-- not secret, but nothing reaches Postgres directly from a client here.
REVOKE ALL ON ftbend_colors FROM anon, authenticated;
REVOKE ALL ON ftbend_color_aliases FROM anon, authenticated;
ALTER TABLE ftbend_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ftbend_color_aliases ENABLE ROW LEVEL SECURITY;

-- Tracking row (migration 029 discipline: every migration inserts its own).
INSERT INTO schema_migrations (filename)
VALUES ('040_ftbend_colors.sql')
ON CONFLICT (filename) DO NOTHING;
