const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

// 2026-11-16. The dashboard's first card is this morning's answer, rendered
// from GET /api/v1/today (§4.1), and the probation countdown counts calendar
// days on the county's clock.
//   - The countdown said "Complete!" on the last day of probation, and showed
//     the end date a day early: new Date('2027-01-02') is UTC midnight, 6 PM
//     the evening before in Texas. The end date is the last day (§3
//     daysRemaining: 0 means "today is the last day").
//   - Reading the date as local midnight instead would miscount by a day
//     across the November clock change. These cases pin both.
//   - The card never shows an answer fetched on an earlier day, and green is
//     the confirmed no-test fact only.

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

const FNS = ['pad2', 'formatTime', 'countyParts', 'countyTodayISO', 'isoDateParts', 'calendarDaysFromToday',
  'formatIsoDate', 'countyClock', 'todayLine', 'todayCap', 'todayList', 'todayOfficeFact', 'todayOfficeHeardAt',
  'todayAnnouncedColor', 'todayView', 'todayPausedView', 'todayEl', 'renderTodayCard'];

// A Date whose "now" is fixed, so the county's day is whatever the case says.
function clockAt(iso) {
  const Real = Date;
  const now = new Real(iso).getTime();
  function FakeDate(...a) { return a.length ? new Real(...a) : new Real(now); }
  FakeDate.UTC = Real.UTC;
  FakeDate.now = () => now;
  FakeDate.prototype = Real.prototype;
  return FakeDate;
}

// Just enough DOM: setting textContent clears the children, as it does in
// a browser, which is how renderTodayCard empties the card between renders.
function el(tag) {
  let text = '';
  return {
    tag, hidden: false, className: '', innerHTML: '', children: [], style: {},
    get textContent() { return text; },
    set textContent(v) { text = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; }
  };
}
const textOf = (e) => [e.textContent].concat(e.children.map(textOf)).filter(Boolean).join(' | ');

function page(nowIso) {
  const els = {};
  ['todayCard', 'todayMark', 'todayDate', 'todayVerdict', 'todayBody', 'todaySched'].forEach((id) => { els[id] = el('div'); });
  const ctx = {
    Date: clockAt(nowIso), Intl, JSON, Math, console,
    TODAY_TZ: 'America/Chicago',
    TODAY_LINES: { montgomery: { tel: '+19362834848', label: '(936) 283-4848' }, missouri: { tel: '+12812383668', label: '(281) 238-3668' } },
    TODAY_OFFICES: { missouri: 'Missouri City', rosenberg: 'Rosenberg', rosenberg2: 'Rosenberg 2' },
    TODAY_ICONS: new Proxy({}, { get: () => '' }), TODAY_PLAY: '',
    todayState: { payload: null, etag: null, fetchedDay: null, failed: false, missing: false, sig: null },
    todaySched: { hour: 6, minute: 0, county: 'montgomery', office: 'missouri', enabled: true },
    document: {
      getElementById: (id) => els[id],
      createElement: (tag) => el(tag),
      createTextNode: (t) => el('#text')
    }
  };
  vm.createContext(ctx);
  vm.runInContext(FNS.map(extract).join('\n'), ctx);
  return { ctx, els };
}

test('countdown: the last day is the last day, on the county clock, in any device zone', () => {
  const cases = [
    ['2027-01-02', '2027-01-02T06:00:00-06:00', 0],
    ['2027-01-02', '2027-01-02T23:59:00-06:00', 0],
    ['2027-01-02', '2027-01-01T06:00:00-06:00', 1],
    ['2027-01-02', '2027-01-03T00:01:00-06:00', -1],
    ['2026-11-02', '2026-11-01T06:00:00-06:00', 1],    // the day the clocks go back
    ['2027-03-15', '2027-03-14T06:00:00-05:00', 1],    // the day they go forward
    ['2026-11-16', '2026-11-16T23:30:00-06:00', 0],    // UTC is already the 17th
    ['not a date', '2026-11-16T06:00:00-06:00', null]
  ];
  for (const [end, now, want] of cases) {
    const { ctx } = page(now);
    assert.strictEqual(ctx.calendarDaysFromToday(end), want, end + ' at ' + now);
  }
  const { ctx } = page('2026-11-16T06:00:00-06:00');
  assert.strictEqual(ctx.formatIsoDate('2027-01-02', null, 'en-US'), '1/2/2027', 'shown as the date that was saved');
});

test('countdown copy: last day, ended, and one day', () => {
  const code = (name) => extract(name).replace(/\/\/.*$/gm, '');   // the comments tell the history
  const src = code('updateProbationDisplay');
  assert.ok(/days === 0[\s\S]*Last day today/.test(src), 'day 0 says it is the last day');
  assert.ok(/days < 0[\s\S]*Ended/.test(src), 'only a past date is ended');
  assert.ok(!src.includes('Complete!'), 'no "Complete!" on any branch');
  assert.ok(!/new Date\(probationEndDate\)/.test(src), 'no UTC parse of the date-only string');
  assert.ok(!/new Date\(endDate\)/.test(code('calculateExactCredits')), 'buy modal reads it the same way');
});

const BASE = { date: '2026-11-16', scheduleId: 's', county: 'montgomery', billed: null, resolvedAt: null,
  attempt: null, maxAttempts: null, nextAttemptAt: null, retryCutoffAt: null, pauseReason: null,
  callLog: [], recording: null, recordingStatus: 'none', fortBend: null };
const at6 = '2026-11-16T06:30:00-06:00';

test('every §2 result renders with its own words, and only NO_TEST is green', () => {
  const { ctx } = page(at6);
  const results = ['SCHEDULED', 'IN_PROGRESS', 'MUST_TEST', 'NO_TEST', 'NO_COLOR', 'UNKNOWN', 'HOTLINE_DOWN',
    'CALL_FAILED', 'WRONG_PIN', 'PIN_EXPIRED', 'NOT_CALLED'];
  const seen = new Set();
  for (const r of results) {
    const v = ctx.todayView(Object.assign({}, BASE, { result: r }));
    assert.ok(v.verdict, r + ' has a headline');
    assert.ok(!seen.has(v.verdict), r + ' does not borrow another state’s headline');
    seen.add(v.verdict);
    assert.strictEqual(v.cls === 't-clear', r === 'NO_TEST', r + ': green is the confirmed no-test fact only');
  }
  assert.strictEqual(ctx.todayView(Object.assign({}, BASE, { result: 'MUST_TEST' })).verdict, 'You test today');
  assert.strictEqual(ctx.todayView(Object.assign({}, BASE, { result: 'NO_TEST' })).verdict, 'No test today');
  // UNKNOWN is final for the morning (§2): nothing says "yet".
  assert.ok(!/yet/i.test(ctx.todayView(Object.assign({}, BASE, { result: 'UNKNOWN' })).verdict));
});

test('an unrecognised result or pause reason is shown raw, with support, never guessed (§1)', () => {
  const { ctx } = page(at6);
  const v = ctx.todayView(Object.assign({}, BASE, { result: 'SOMETHING_NEW' }));
  assert.ok(v.detail.includes('SOMETHING_NEW'));
  assert.ok(v.actions.some((a) => a.kind === 'help'));
  const p = ctx.todayView(Object.assign({}, BASE, { result: 'NOT_CALLED', pauseReason: 'new_reason' }));
  assert.ok(p.detail.includes('new_reason'));
  assert.ok(p.actions.some((a) => a.kind === 'help'));
});

test('no-result mornings point at the county line; every pause does too', () => {
  const { ctx } = page(at6);
  for (const r of ['UNKNOWN', 'HOTLINE_DOWN', 'CALL_FAILED', 'WRONG_PIN', 'PIN_EXPIRED']) {
    assert.ok(ctx.todayView(Object.assign({}, BASE, { result: r })).actions.some((a) => a.kind === 'call'), r);
  }
  for (const reason of ['no_credits', 'unknown_streak', 'wrong_pin', 'pin_expired', 'sms_opted_out', 'user', null]) {
    const v = ctx.todayView(Object.assign({}, BASE, { result: 'NOT_CALLED', pauseReason: reason }));
    assert.ok(v.actions.some((a) => a.kind === 'call'), 'paused ' + reason);
  }
});

// 2026-11-17, the app's 092660b: "check the county line to be safe" reads as
// "look at the app", which is the thing that failed. UNKNOWN states the
// fact, that nobody checked, and the one action; anywhere the card sends
// someone to the hotline, the word is "call".
test('UNKNOWN says nobody checked and to call the county line; no hotline line says "check" or hedges', () => {
  const { ctx } = page(at6);
  const unknown = ctx.todayView(Object.assign({}, BASE, { result: 'UNKNOWN' }));
  assert.strictEqual(unknown.verdict, 'No clear answer today', 'the app’s headline');
  assert.strictEqual(unknown.detail,
    'The recording couldn’t be read clearly, so nobody has checked whether you test today. Call the county line yourself.',
    'the app’s sentence, word for word');
  const surfaces = ['UNKNOWN', 'HOTLINE_DOWN', 'CALL_FAILED', 'WRONG_PIN', 'PIN_EXPIRED', 'SOMETHING_NEW']
    .map((r) => [r, ctx.todayView(Object.assign({}, BASE, { result: r }))])
    .concat(['no_credits', 'unknown_streak', 'wrong_pin', 'pin_expired', 'sms_opted_out', 'user', null, 'new_reason']
      .map((reason) => ['paused ' + reason, ctx.todayView(Object.assign({}, BASE, { result: 'NOT_CALLED', pauseReason: reason }))]));
  for (const [name, v] of surfaces) {
    const text = [v.verdict, v.detail, v.note].join(' ');
    for (const hedge of ['check the', 'to be safe', 'to be sure']) {
      assert.ok(!text.toLowerCase().includes(hedge), name + ': "' + hedge + '" in ' + text);
    }
  }
  for (const r of ['UNKNOWN', 'HOTLINE_DOWN', 'CALL_FAILED', 'WRONG_PIN', 'PIN_EXPIRED', 'SOMETHING_NEW']) {
    const v = ctx.todayView(Object.assign({}, BASE, { result: r }));
    assert.ok(/call the county line/i.test(v.detail), r + ' says to call the county line');
  }
  assert.ok(!/\byet\b/i.test(unknown.verdict + ' ' + unknown.detail), 'nothing more is coming today');
});

test('Fort Bend shows what the office announced, and NO_COLOR is the fact plus the fix', () => {
  const { ctx } = page(at6);
  const board = { yourOffice: 'missouri', yourColor: 'zinc', offices: [
    { office: 'missouri', announced: ['ruby', 'gold'], phases: null, heardAt: '2026-11-16T11:06:47Z' },
    { office: 'rosenberg', announced: ['zinc'], phases: null, heardAt: null }] };
  const v = ctx.todayView(Object.assign({}, BASE, { county: 'ftbend', result: 'NO_TEST', fortBend: board }));
  assert.strictEqual(v.fact, 'Missouri City announced Ruby and Gold. Your color is Zinc.');
  assert.strictEqual(ctx.todayOfficeHeardAt({ fortBend: board }), '2026-11-16T11:06:47Z');
  const nc = ctx.todayView(Object.assign({}, BASE, { county: 'ftbend', result: 'NO_COLOR',
    fortBend: Object.assign({}, board, { yourColor: null }) }));
  assert.strictEqual(nc.detail, 'Today’s color is Ruby and Gold. Set your color to get a verdict.');
  assert.ok(!nc.actions.some((a) => a.kind === 'retry'), 'no retry on NO_COLOR');
});

test('"not charged" comes from billed === false only', () => {
  const { ctx, els } = page(at6);
  const show = (billed) => {
    ctx.todayState.payload = Object.assign({}, BASE, { result: 'UNKNOWN', billed, resolvedAt: '2026-11-16T19:00:00Z' });
    ctx.todayState.fetchedDay = '2026-11-16';
    ctx.todayState.sig = null;
    ctx.renderTodayCard();
    return textOf(els.todayBody);
  };
  assert.ok(show(false).includes('You were not charged.'));
  assert.ok(!show(null).includes('not charged'), 'null is unknown, never a denial');
  assert.ok(!show(true).includes('not charged'));
});

test('an answer fetched on an earlier day is never shown as today’s', () => {
  // Fetched yesterday (a page left open overnight); it is now 12:05 AM.
  const { ctx, els } = page('2026-11-17T00:05:00-06:00');
  ctx.todayState.payload = Object.assign({}, BASE, { result: 'NO_TEST', billed: true, resolvedAt: '2026-11-16T12:00:29Z' });
  ctx.todayState.fetchedDay = '2026-11-16';
  ctx.renderTodayCard();
  assert.notStrictEqual(els.todayVerdict.textContent, 'No test today');
  assert.ok(/Checking/.test(els.todayVerdict.textContent));
  assert.ok(els.todayDate.textContent.startsWith('Tuesday, November 17'));

  // And when that refresh fails, it says so instead of falling back.
  ctx.todayState.failed = true;
  ctx.renderTodayCard();
  assert.ok(/Couldn’t load/.test(els.todayVerdict.textContent));
  assert.ok(!/No test/.test(textOf(els.todayBody)));
});

test('no schedule: the card hides and the "No schedule set" strip speaks', () => {
  const { ctx, els } = page(at6);
  ctx.todayState.missing = true;
  ctx.renderTodayCard();
  assert.strictEqual(els.todayCard.hidden, true);
});

test('the answer is requested before /api/user, and the green banner is gone', () => {
  const lu = extract('loadUser');
  assert.ok(lu.indexOf('loadToday();') >= 0 && lu.indexOf('loadToday();') < lu.indexOf("fetch('/api/user'"),
    '/today goes out first, on its own');
  assert.ok(!/id="scheduleBanner"/.test(dash), 'banner element removed');
  assert.ok(!/getElementById\('scheduleBanner/.test(dash), 'and nothing writes to it');
});
