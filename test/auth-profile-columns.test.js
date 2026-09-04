const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// auth() sets req.profile, and GET /api/user hands that object to the web
// dashboard VERBATIM. So narrowing the select is only safe if the column list
// covers every consumer — in this file, in the dashboard, and in the libs that
// receive a profile. This test RE-DERIVES that union from the sources rather
// than trusting a list someone maintained by hand: the path runs on every
// authenticated request, so a missing column is a widespread failure, not a
// cosmetic one.
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
const billing = fs.readFileSync(path.join(root, 'lib', 'billing.js'), 'utf8');

function selected() {
  const m = server.match(/var AUTH_PROFILE_COLUMNS = \[([\s\S]*?)\]\.join/);
  assert.ok(m, 'AUTH_PROFILE_COLUMNS not found in server.js');
  return new Set(m[1].match(/'([a-z_]+)'/g).map(s => s.replace(/'/g, '')));
}

function grepFields(src, patterns) {
  const out = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
}

// Computed on the object after load, never selected from the table.
const COMPUTED = new Set(['isDev']);

test('the auth() select covers every field read off req.profile', function() {
  const cols = selected();
  const needed = grepFields(server, [/req\.profile\.([a-zA-Z_][a-zA-Z0-9_]*)/g]);
  const missing = [...needed].filter(f => !COMPUTED.has(f) && !cols.has(f));
  assert.deepStrictEqual(missing, [], 'server.js reads these but auth() does not select them: ' + missing);
});

test('it covers what the dashboard reads off the profile it is handed', function() {
  // GET /api/user returns req.profile as-is, so the browser is a consumer.
  const cols = selected();
  const needed = grepFields(dash, [
    /d\.profile\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    /\bprofile\.([a-zA-Z_][a-zA-Z0-9_]*)/g,   // getSubscriptionState(profile), renderSubscriptionStatus(profile)
  ]);
  const missing = [...needed].filter(f => !COMPUTED.has(f) && !cols.has(f));
  assert.deepStrictEqual(missing, [], 'dashboard.html reads these but auth() does not select them: ' + missing);
});

test('it covers lib/billing.js, which is handed req.profile directly', function() {
  const cols = selected();
  const needed = grepFields(billing, [/profile\.([a-zA-Z_][a-zA-Z0-9_]*)/g]);
  const missing = [...needed].filter(f => !cols.has(f));
  assert.deepStrictEqual(missing, [], 'lib/billing.js reads these but auth() does not select them: ' + missing);
});

test('it still excludes the jsonb columns that made this query fat', function() {
  // Migration 048's columns are read by the payout batch and GET /referral,
  // both of which load their own rows. If they reappear here, the regression
  // is back.
  const cols = selected();
  ['stripe_connect_requirements_currently_due', 'stripe_connect_requirements_eventually_due',
   'stripe_connect_requirements_past_due', 'stripe_connect_disabled_reason'].forEach(function(c) {
    assert.ok(!cols.has(c), c + ' is back in the hot auth() path');
  });
});
