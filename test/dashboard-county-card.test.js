const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

// 2026-10-13. The dashboard's frequency card, run as the page runs it: the
// page's own calculateTestStats and renderFtbendColorCard, a fake DOM, and
// the §4.10 / §4.11 payloads handed to fetch.
//   - The "<Day>s run heaviest" line exists only while the server's
//     rate-based test says so (countyDaily.elevatedSignificant). When that
//     stops being true the line goes away with no page change.
//   - A Fort Bend subscriber gets their colour at their office, and none of
//     Montgomery's blocks.

function extract(name) {
  const start = dash.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should be in dashboard.html');
  let depth = 0;
  for (let i = dash.indexOf('{', start); i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}' && --depth === 0) return dash.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

function el() {
  return {
    style: {}, textContent: '', innerHTML: '', className: '', clientWidth: 600, children: [],
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; }
  };
}
const textOf = (e) => [e.textContent].concat(e.children.map(textOf)).filter(Boolean).join(' | ');

async function run(responses) {
  const els = {};
  const ctx = {
    token: 'tok', console,
    document: { getElementById: (id) => els[id] || (els[id] = el()), createElement: () => el() },
    fetch: (url) => Promise.resolve({ json: () => Promise.resolve(responses[url]) }),
    buildDaysGauge: () => '', buildTestTimeline: () => '', buildWeekdayVisual: () => '[weekday grid]'
  };
  vm.createContext(ctx);
  vm.runInContext("var FT_OFFICE_NAMES = { missouri: 'Missouri City', rosenberg: 'Rosenberg', rosenberg2: 'Rosenberg 2' };\n" +
    ['mkEl', 'shortDay', 'renderFtbendColorCard', 'calculateTestStats'].map(extract).join('\n'), ctx);
  ctx.calculateTestStats();
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  return els;
}

// A Montgomery person with too few of their own tests for a personal day
// pattern, which is the branch that talks about the county.
function montgomery(countyDaily, countyDayPattern) {
  return {
    county: 'montgomery', testsCounted: 6, daysSinceLastTest: 9, yourIntervalDays: 21.5, testsPerMonth: 1.4,
    observationDays: 180, window: { state: 'insufficient', intervalsUsed: 3, needed: 5 }, dayOfWeek: null,
    recentTests: [], rapidRetestsIncluded: 0, unobservedGapsExcluded: 0, escalation: null,
    countyDayCounts: [0, 14, 15, 17, 25, 12, 2], countyDayPattern: countyDayPattern, countyDaily: countyDaily
  };
}
const DAILY = { todayPercent: 4.7, baselinePercent: 4.7, todayBasis: 'baseline', basedOnTests: 85, basedOnUsers: 21, gapBand: null };
const WEEK = { fullWeekSignificant: true, weekdaySignificant: true, total: 85, weekendCount: 2 };

test('the day is named when the server finds it significant', async () => {
  const els = await run({ '/api/v1/prediction': montgomery(Object.assign({}, DAILY, {
    elevatedSignificant: true, elevatedDays: [{ day: 'thursday', percent: 10, count: 25, opportunities: 251 }] }), WEEK) });
  assert.strictEqual(els.testStatsCard.style.display, 'block');
  assert.match(els.patternRow.innerHTML, /Thursdays run heaviest\./);
  assert.match(els.patternRow.innerHTML, /Across Montgomery County, Thursdays have come back with a test more often than the county's usual day\./);
  assert.ok(!/twice/.test(els.patternRow.innerHTML), 'no multiplier');
  assert.ok(!/\[weekday grid\]/.test(els.patternRow.innerHTML), 'and no seven-day grid beside a named day');
});

test('the line disappears on its own when the server stops finding it significant', async () => {
  // The old gate (countyDayPattern.weekdaySignificant) is still TRUE here,
  // and the raw counts still peak on Thursday. Neither can show the line.
  const els = await run({ '/api/v1/prediction': montgomery(Object.assign({}, DAILY, { elevatedSignificant: false, elevatedDays: [] }), WEEK) });
  assert.ok(!/run heaviest/.test(els.patternRow.innerHTML));
  assert.match(els.patternRow.innerHTML, /Stay ready every weekday\./);
  assert.match(els.patternRow.innerHTML, /Montgomery County overall: 83 of 85 recorded tests fell on weekdays/);
});

test('not significant means no line even if a day is still listed, or the block is missing', async () => {
  const stale = await run({ '/api/v1/prediction': montgomery(Object.assign({}, DAILY, {
    elevatedSignificant: false, elevatedDays: [{ day: 'thursday', percent: 10, count: 25, opportunities: 251 }] }), WEEK) });
  assert.ok(!/run heaviest/.test(stale.patternRow.innerHTML));
  const none = await run({ '/api/v1/prediction': montgomery(null, null) });
  assert.ok(!/run heaviest/.test(none.patternRow.innerHTML));
  assert.match(none.patternRow.innerHTML, /Stay ready any day\./);
  const odd = await run({ '/api/v1/prediction': montgomery(Object.assign({}, DAILY, {
    elevatedSignificant: true, elevatedDays: [{ day: '<img src=x>', percent: 10, count: 1, opportunities: 1 }] }), WEEK) });
  assert.ok(!/run heaviest|<img/.test(odd.patternRow.innerHTML), 'a day name the page does not know is never placed in markup');
});

const FT_PREDICTION = {
  county: 'ftbend', testsCounted: 1, daysSinceLastTest: 12, countyDaily: null, countyDayPattern: null, countyDayCounts: null,
  colorHistory: { office: 'missouri', color: 'gray', lastCalledDate: '2026-10-01', daysSinceLastCalled: 12, timesCalled: 2, recordedSince: '2026-09-18' }
};
const FT_STATS = { fortBend: {
  office: 'missouri', totalCallsLogged: 6,
  mostCalled: [{ name: 'Lemon', hex: '#fff44f', count: 2, percent: 33 }, { name: 'Gray', hex: '#808080', count: 2, percent: 33 }],
  recent: [
    { date: '2026-10-13', offices: [{ office: 'missouri', announced: ['pink'], phases: [] }, { office: 'rosenberg2', announced: ['gray'], phases: [] }] },
    { date: '2026-10-12', offices: [{ office: 'rosenberg', announced: ['iron'], phases: [] }] }
  ] } };

test('a Fort Bend subscriber sees their colour at their office, and nothing of Montgomery', async () => {
  const els = await run({ '/api/v1/prediction': FT_PREDICTION, '/api/v1/county-stats': FT_STATS });
  assert.strictEqual(els.testStatsCard.style.display, 'block', 'the card is shown — it used to be hidden or wrong');
  assert.strictEqual(els.ftColorCard.style.display, 'block');
  for (const id of ['mgStatsGrid', 'testPrediction', 'mgPatternBlock']) assert.strictEqual(els[id].style.display, 'none', id + ' is hidden');
  const text = textOf(els.ftColorCard);
  assert.match(text, /^12 \| days since Gray was last called at Missouri City/);
  assert.match(text, /called 2 times since Sep 18/);
  assert.match(text, /MOST CALLED AT MISSOURI CITY \| Lemon \| 2 times · 33% \| Gray/);
  assert.match(text, /RECENT AT MISSOURI CITY \| Oct 13 \| pink/);
  assert.strictEqual(text.split('RECENT AT MISSOURI CITY | ')[1].split(' | From Missouri')[0], 'Oct 13 | pink',
    "only their office's days: not Rosenberg 2's gray that morning, not Rosenberg's Oct 12");
  assert.ok(!/Montgomery/.test(text));
  assert.strictEqual(els.patternRow, undefined, 'the Montgomery pattern block is never touched');
});

test('Fort Bend with no colour, or a colour never called, says so plainly', async () => {
  const noColour = await run({ '/api/v1/prediction': Object.assign({}, FT_PREDICTION, { colorHistory: { office: 'rosenberg2', color: null, lastCalledDate: null, daysSinceLastCalled: null, timesCalled: 0, recordedSince: '2026-09-18' } }), '/api/v1/county-stats': {} });
  assert.match(textOf(noColour.ftColorCard), /^Set your colour on the Schedule tab to see when it was last called at Rosenberg 2\./);
  const never = await run({ '/api/v1/prediction': Object.assign({}, FT_PREDICTION, { testsCounted: 0, colorHistory: { office: 'missouri', color: 'teal', lastCalledDate: null, daysSinceLastCalled: null, timesCalled: 0, recordedSince: '2026-09-18' } }), '/api/v1/county-stats': {} });
  assert.match(textOf(never.ftColorCard), /^Teal has not been called at Missouri City since our record began on Sep 18\./);
  assert.strictEqual(never.testStatsCard.style.display, 'block', 'zero tests of their own no longer hides the card');
});

test('the website: a card per county, the day named by the server, an archive for the old county', () => {
  const start = dash.indexOf('function calculateTestStats()');
  const card = dash.slice(start, dash.indexOf('\nfunction historyWhen', start));
  assert.match(card, /var isFt = p\.county === 'ftbend';/);
  assert.match(card, /if \(isFt\) \{ card\.style\.display = "block"; renderFtbendColorCard\(p\); return; \}/);
  assert.ok(!/Across Montgomery County|Montgomery County overall/.test(card), 'no county name is hard-coded in the card');
  assert.match(card, /var elevated = \(cd && cd\.elevatedSignificant && cd\.elevatedDays && cd\.elevatedDays\.length\) \? cd\.elevatedDays\[0\] : null;/, 'the named day is the server\'s rate-based test');
  assert.ok(!/county\.weekdaySignificant/.test(card.replace(/\/\/.*$/gm, '')), 'not the old count-only gate');
  assert.match(card, /if \(hotDay\) \{/, 'no elevated day from the server, no line');
  assert.match(dash, /function showHistoryArchive\(c\)/);
  assert.match(dash, /'\/api\/v1\/history\?county=' \+ encodeURIComponent\(asked\)/);
  assert.match(dash, /It is kept, and it is not part of your current numbers\./);
  const fb = dash.slice(dash.indexOf('function renderFtbendColorCard(p)'), dash.indexOf('function buildHistoryFilters()'));
  assert.ok(!/innerHTML/.test(fb.replace(/\/\/.*$/gm, '')), 'server text is placed with textContent');
});
