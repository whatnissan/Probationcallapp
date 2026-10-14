const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const view = require('../lib/county-view');
const ftbend = require('../lib/ftbend');
const Core = require('../public/prediction-core.js').PredictionCore;
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-13. A person's numbers come from the county they are in NOW;
// nothing is deleted; an old county's history is an archive, never mixed in.
// The fixture is the account the bug was found on: Montgomery until
// September, Fort Bend (Missouri City, Gray) since.

const at = (d) => d + 'T11:00:00Z';
const HISTORY = [
  { county: 'montgomery', result: 'MUST_TEST', created_at: at('2026-04-09') },
  { county: 'montgomery', result: 'NO_TEST', created_at: at('2026-06-01') },
  { county: 'montgomery', result: 'MUST_TEST', created_at: at('2026-08-20') },
  { county: 'montgomery', result: 'MUST_TEST', created_at: at('2026-09-03') },
  { county: 'montgomery', result: 'NO_TEST', created_at: at('2026-09-24') },
  { county: 'ftbend', result: 'COLOR:Lemon', verdict: 'NO_TEST', created_at: at('2026-09-30') },
  { county: 'ftbend', result: 'COLOR:Gray', verdict: 'MUST_TEST', created_at: at('2026-10-01') },
  { county: 'ftbend', result: 'COLOR:Burgundy', verdict: 'NO_TEST', created_at: at('2026-10-02') }
];
const NOW = Date.parse('2026-10-13T15:00:00Z');

test('a Fort Bend answer is the verdict; a Montgomery answer is the result', () => {
  assert.strictEqual(view.answerOf(HISTORY[6]), 'MUST_TEST');
  assert.strictEqual(view.answerOf(HISTORY[0]), 'MUST_TEST');
  assert.strictEqual(view.answerOf({ county: 'ftbend', result: 'COLOR:Gray' }), 'COLOR:Gray', 'no stored verdict is never guessed into one');
  assert.strictEqual(view.countyOf({}), 'montgomery');
  assert.strictEqual(view.countyOf({ county: 'ftbend' }), 'ftbend');
});

test('the bug: unfiltered history said 40 days; the current county says 12', () => {
  // What the endpoint did: every row, counting result === MUST_TEST.
  const before = Core.computePrediction(HISTORY.map((r) => ({ result: r.result, created_at: r.created_at })), null, NOW);
  assert.strictEqual(before.daysSince, 40, 'Sep 3, the last MONTGOMERY test');
  assert.strictEqual(before.tests, 3);
  // What it does now.
  const now = Core.computePrediction(view.asTestRows(view.rowsForCounty(HISTORY, 'ftbend')), null, NOW);
  assert.strictEqual(now.daysSince, 12, 'Oct 1, the Fort Bend test');
  assert.strictEqual(now.tests, 1, 'and no Montgomery test is counted');
});

test('a Montgomery person is unaffected', () => {
  const rows = view.asTestRows(view.rowsForCounty(HISTORY.slice(0, 5), 'montgomery'));
  assert.strictEqual(Core.computePrediction(rows, null, NOW).tests, 3);
});

test('each county is summarised separately, current first, nothing dropped', () => {
  const s = view.countySummaries(HISTORY, 'ftbend');
  assert.deepStrictEqual(s, [
    { county: 'ftbend', current: true, firstDate: '2026-09-30', lastDate: '2026-10-02', results: 3, tests: 1 },
    { county: 'montgomery', current: false, firstDate: '2026-04-09', lastDate: '2026-09-24', results: 5, tests: 3 }
  ]);
  assert.strictEqual(s.reduce((n, c) => n + c.results, 0), HISTORY.length, 'every row is in exactly one county');
  assert.deepStrictEqual(view.countySummaries(HISTORY.slice(0, 5), 'montgomery').map((c) => c.county), ['montgomery'], 'one county: no archive');
});

test("a colour's history is its OWN office's — another office calling it does not count", () => {
  const offices = [
    { county: 'ftbend_missouri', date: '2026-09-18', color: 'Gray', phase1_color: 'Gray' },
    { county: 'ftbend_missouri', date: '2026-10-01', color: 'Gray', phase1_color: 'Gray' },
    { county: 'ftbend_rosenberg2', date: '2026-10-02', color: 'Gray', phase1_color: 'Gray' },   // the day after, elsewhere
    { county: 'ftbend_missouri', date: '2026-10-02', color: 'Burgundy', phase1_color: null },
    { county: 'ftbend_rosenberg2', date: '2026-10-03', color: 'Phase 1 B, Phase 3', phase1_color: 'Phase 1 B', phase2_color: 'Phase 3' }
  ];
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'missouri', 'gray'), ['2026-09-18', '2026-10-01'], 'Missouri City: Oct 1, so 12 days on Oct 13');
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'rosenberg2', 'gray'), ['2026-10-02']);
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'missouri', 'Burgundy'), ['2026-10-02'], 'found from the colour when the phase column is empty');
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'rosenberg2', 'Phase 3'), ['2026-10-03'], 'a phase group counts the same way a verdict does');
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'missouri', null), []);
  assert.deepStrictEqual(ftbend.colourCallDates(offices, 'houston', 'gray'), [], 'unknown office: nothing');
});

// A handler or function, whole: from its first line to its closing line at
// column 0. Comments stripped so the assertions read code, not prose.
function fn(name) {
  const i = server.indexOf(name);
  assert.ok(i > 0, name + ' should be findable');
  const ends = [server.indexOf('\n});', i), server.indexOf('\n}\n', i)].filter((n) => n > 0);
  return server.slice(i, Math.min.apply(null, ends)).replace(/\/\/.*$/gm, '');
}

test('the prediction reads the current county only, and never blends Montgomery into Fort Bend', () => {
  const h = fn("app.get('/api/v1/prediction'");
  assert.match(h, /\.select\('result, verdict, county, created_at'\)\s*\.eq\('user_id', req\.user\.id\)\.eq\('county', county\)/);
  assert.match(h, /countyView\.asTestRows\(countyView\.rowsForCounty\(hist\.data \|\| \[\], county\)\)/);
  assert.match(h, /if \(!isFt\) \{\s*try \{ sysStats = await computeSystemStats\(\); \}/, 'county statistics are Montgomery\'s');
  assert.match(h, /var countyPattern = isFt \? null : /);
  assert.match(h, /colorHistory = await ftbendColorHistoryFor\(req\.user\.id, sched\.data\)/);
  assert.match(fn('async function ftbendColorHistoryFor('), /\.eq\('county', 'ftbend_' \+ office\)/, 'the subscriber\'s office only');
  assert.match(h, /var county = await currentCountyForUser\(req\.user\.id, sched\.data\);/, 'one definition of the current county');
  assert.match(fn('async function ftbendColorHistoryFor('), /if \(!sched\) return null;/, 'no schedule: no office is guessed');
});

test('history, today and county-stats are each one county (or one office)', () => {
  const hist = fn("app.get('/api/v1/history'");
  assert.match(hist, /\.eq\('county', servedCounty\)/);
  assert.match(hist, /county must be "montgomery" or "ftbend"\./, 'an unknown ?county= is a 400');
  assert.match(hist, /county: servedCounty,\s*isArchive: servedCounty !== currentCounty,\s*counties: historyCounties,/);
  assert.match(fn("app.get('/api/v1/today'"), /\.eq\('county', countyView\.normaliseCounty\(county\)\)/);
  const cs = fn("app.get('/api/v1/county-stats'");
  assert.match(cs, /\.eq\('county', 'ftbend_' \+ ftOffice\)/, 'not all three offices pooled');
  assert.match(cs, /ftbend\.colourCallDates\(rows, ftOffice, prof\.data\.user_color\)/);
  assert.match(cs, /office: ftOffice,/);
  assert.match(server, /historyCounties: await currentCountyForUser\(req\.user\.id, sched\.data\)/, '/me lists the counties');
  // Nothing in this change deletes a result.
  assert.ok(!/from\('call_history'\)\.delete\(\)/.test(fn("app.get('/api/v1/history'") + fn("app.get('/api/v1/prediction'")));
});
