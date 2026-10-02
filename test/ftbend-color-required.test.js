const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-09-30: a Fort Bend schedule was created on the website with no colour.
// It saved, billed a credit a morning, and delivered an announcement with no
// verdict — rendered by the app as "the recording couldn't be read clearly",
// which was false. Two fixes, pinned here because both are easy to lose.

test('every writer refuses a Fort Bend schedule with no colour', () => {
  // v1 PUT /schedule
  const v1Start = server.indexOf("app.put('/api/v1/schedule'");
  const v1 = server.slice(v1Start, server.indexOf("app.post('/api/v1/schedule/pause'", v1Start) > 0
    ? server.indexOf("app.post('/api/v1/schedule/pause'", v1Start) : v1Start + 30000);
  assert.match(v1, /county === 'ftbend' && !ftbendColorName/, 'v1 checks the colour for Fort Bend');
  assert.match(v1, /ftbend_color_required/, 'and refuses with the documented code');
  assert.match(v1, /'ftbendColor'\)/, 'naming the field (§1)');
  // the website's own save
  const web = server.slice(server.indexOf("app.post('/api/schedule'"), server.indexOf("app.post('/api/schedule'") + 3000);
  assert.match(web, /=== 'ftbend'/, 'the web writer checks the county');
  assert.match(web, /field: 'ftbendColor'/, 'and names the field too');
  assert.match(web, /Choose your assigned Fort Bend colour/);
});

test('the colour endpoint validates against the catalogue and refuses empty', () => {
  const ep = server.slice(server.indexOf("app.post('/api/profile/color'"), server.indexOf("app.post('/api/profile/color'") + 2000);
  assert.match(ep, /resolveColor\(colorCatalog, color\)/, 'an unrecognised colour never matches an announcement');
  assert.match(ep, /field: 'ftbendColor'/);
});

test('no colour on file reports NO_COLOR, never UNKNOWN', () => {
  const i = server.indexOf('No colour on file.');
  assert.ok(i > 0, 'the no-colour branch should be findable');
  const branch = server.slice(i, i + 1400);
  // The verdict comes from the ONE shared rule (2026-10-02), which the
  // morning delivery and the signup-day answer both call.
  const { verdictFor } = require('../lib/ftbend');
  assert.strictEqual(verdictFor(null, ['gray'], false), 'NO_COLOR', 'no colour on file is NO_COLOR');
  assert.strictEqual(verdictFor('', ['gray'], false), 'NO_COLOR');
  assert.match(server, /var ftVerdict = ftbend\.verdictFor\(userColor, todayColors, isUnknown\);/, 'delivery uses it');
  assert.ok(!/ftVerdict = 'UNKNOWN'/.test(branch), 'the branch must not fall back to UNKNOWN');
  // Only the MESSAGE, not the comment above it, which quotes the old wording.
  const msg = /personalMsg = ('(?:[^'\\]|\\.)*'(?:\s*\+\s*[^;]+)?);/.exec(branch);
  assert.ok(msg, 'the branch should build a message');
  assert.match(msg[1], /no colour saved/i, 'the message says what is missing');
  assert.ok(!/could not (be )?(read|detect)|unclear|couldn.t tell/i.test(msg[1]),
    'and never claims the recording failed');
});

test('NO_COLOR survives the v1 result mapping and counts as today\'s answer', () => {
  const passthrough = /var V1_RESULT_PASSTHROUGH = (\/\^.*\$\/);/.exec(server);
  const usable = /var V1_USABLE_TODAY = (\/\^.*\/);/.exec(server);
  assert.ok(passthrough && usable);
  assert.ok(eval(passthrough[1]).test('NO_COLOR'), 'passed through, not remapped to UNKNOWN');
  assert.ok(eval(usable[1]).test('NO_COLOR'), 'and it is a real answer for today, not a gap');
});

test('NO_COLOR never pushes — it is an action item, like UNKNOWN', () => {
  const i = server.indexOf("if (ftVerdict === 'MUST_TEST' || ftVerdict === 'NO_TEST')");
  assert.ok(i > 0, 'the push gate should still name only the two verdicts that push');
});

// The dead end this closes (2026-09-30): the server refuses a Fort Bend
// schedule with no colour, the website's schedule form had no colour field,
// and the colour lived on a different tab — so the form could not save at
// all. Onboarding had the same shape: schedule first, colour after, which
// would now fail at the first step.
test('the website saves the colour WITH the schedule, in one request', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="schedColorGroup"/, 'the schedule form has a colour group');
  assert.match(dash, /id="schedColor"/, 'with a picker, not free text');
  // Both POSTs to /api/schedule carry the colour.
  // Every place that sends a schedule BODY must send the colour with it.
  const posts = dash.split("fetch('/api/schedule'").slice(1)
    .map(function (chunk) { return chunk.slice(0, 1600); })
    .filter(function (chunk) { return /body: JSON\.stringify\(\{[\s\S]{0,80}county:/.test(chunk); });
  assert.strictEqual(posts.length, 2, 'the schedule form and onboarding are the two schedule writes');
  posts.forEach(function (chunk, i) {
    assert.match(chunk, /ftbendColor/, 'schedule POST #' + (i + 1) + ' sends the colour');
  });
  // The picker is filled from the catalogue, so 'blueish' cannot be typed in.
  assert.match(dash, /\/api\/ftbend\/catalog/);
  assert.match(dash, /function fillColorPickers/);
  // And the group follows the county, like the office select.
  assert.match(dash, /schedColorGroup\.style\.display = isFtbend/);
});

test('the catalogue endpoint serves the picker, colours before program rows', () => {
  const server2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = server2.indexOf("app.get('/api/ftbend/catalog'");
  assert.ok(i > 0, 'the web catalogue endpoint exists');
  const ep = server2.slice(i, i + 1200);
  assert.match(ep, /loadColorCatalog\(\)/, 'one source: the same catalogue detection uses');
  assert.match(ep, /isProgram \? 1 : -1/, 'Prep designations sort last');
});
