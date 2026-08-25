const test = require('node:test');
const assert = require('node:assert');

const { PredictionCore } = require('../public/prediction-core.js');

// Build a MUST_TEST history from day offsets (day 0 = 2026-01-01).
const T0 = new Date('2026-01-01T12:00:00Z').getTime();
function tests(dayOffsets) {
  return dayOffsets.map(d => ({ created_at: new Date(T0 + d * 864e5).toISOString(), result: 'MUST_TEST' }));
}
function daysAfter(d) { return T0 + d * 864e5; }

test('sub-7-day gaps are INCLUDED in interval math (retest-exclusion reversed 2026-08-21)', function() {
  // Gaps: 20, 20, 4. The pre-reversal model dropped the 4 as a "retest" and
  // averaged 20; the current model includes it — rapid re-calls are the
  // county's escalation signal, not noise.
  const p = PredictionCore.computePrediction(tests([0, 20, 40, 44]), null, daysAfter(45));
  assert.strictEqual(p.usedIntervals, 3, 'all three gaps count');
  assert.strictEqual(p.sub7Count, 1, 'still counted separately for display');
  assert.ok(p.avgDays < 15 && p.avgDays > 12,
    'average pulled below 20 by the included escalation gap (got ' + p.avgDays.toFixed(2) + ')');
});

test('recency weighting: newest interval carries the most weight (half-life 4)', function() {
  // Gaps oldest→newest: 10, 10, 10, 30. Plain mean = 15; exponential decay
  // with half-life 4 gives (10·.5946 + 10·.7071 + 10·.8409 + 30·1) / 3.1426 ≈ 16.36.
  const p = PredictionCore.computePrediction(tests([0, 10, 20, 30, 60]), null, daysAfter(61));
  assert.ok(Math.abs(p.avgDays - 16.36) < 0.05, 'weighted mean ≈ 16.36, got ' + p.avgDays.toFixed(3));
});

test('60d+ gap included only when call coverage proves we were watching', function() {
  // Two tests 70 days apart. With near-daily NO_TEST rows between them the
  // gap is a real county cadence (ewing case: 91% coverage on a 63d gap);
  // without them it is an observation hole and must be dropped.
  const covered = tests([0, 70]);
  for (let d = 1; d < 70; d++) covered.push({ created_at: new Date(T0 + d * 864e5).toISOString(), result: 'NO_TEST' });
  const withCoverage = PredictionCore.computePrediction(covered, null, daysAfter(71));
  assert.strictEqual(withCoverage.usedIntervals, 1);
  assert.strictEqual(withCoverage.longIncluded, 1);

  const bare = PredictionCore.computePrediction(tests([0, 70]), null, daysAfter(71));
  assert.strictEqual(bare.usedIntervals, 0);
  assert.strictEqual(bare.longDropped, 1);
});

test('blend: thin personal history leans on system-wide stats (pw = n/8)', function() {
  // One personal interval of 20 vs system avg 30: blended = 30·(7/8) + 20·(1/8) = 28.75.
  const p = PredictionCore.computePrediction(
    tests([0, 20]), { scheduledAvg: 30, scheduledStdDev: 5 }, daysAfter(21));
  assert.ok(Math.abs(p.avgDays - 28.75) < 0.01, 'got ' + p.avgDays);
  assert.strictEqual(p.sourceLabel, 'county + your history');
});

test('blend: 8+ personal intervals give full personal weight', function() {
  const offsets = [];
  for (let i = 0; i <= 8; i++) offsets.push(i * 10); // 8 intervals of 10d
  const p = PredictionCore.computePrediction(
    tests(offsets), { scheduledAvg: 30, scheduledStdDev: 5 }, daysAfter(81));
  assert.ok(Math.abs(p.avgDays - 10) < 0.01, 'pure personal mean, got ' + p.avgDays);
  assert.strictEqual(p.sourceLabel, 'your history + county');
});

test('escalation flag: latest interval at/under half the running median', function() {
  const flagged = PredictionCore.computePrediction(tests([0, 20, 40, 60, 68]), null, daysAfter(69));
  assert.ok(flagged.escalation, 'gap of 8 vs median 20 flags');
  assert.strictEqual(flagged.escalation.lastGapDays, 8);
  const calm = PredictionCore.computePrediction(tests([0, 20, 40, 60, 72]), null, daysAfter(73));
  assert.strictEqual(calm.escalation, null, 'gap of 12 vs median 20 does not flag');
});

test('day grid stays suppressed below 35 tests, even with a perfect pattern', function() {
  const mondays = [];
  for (let i = 0; i < 20; i++) mondays.push(4 + i * 7); // 2026-01-05 is a Monday
  const p = PredictionCore.computePrediction(tests(mondays), null, daysAfter(200));
  assert.strictEqual(p.dayGrid.show, false);
  assert.match(p.dayGrid.reason, /35\+/);
});

test('day grid shows at 35+ tests ONLY with a significant chi-square', function() {
  const mondays = [];
  for (let i = 0; i < 40; i++) mondays.push(4 + i * 7);
  const patterned = PredictionCore.computePrediction(tests(mondays), null, daysAfter(300));
  assert.strictEqual(patterned.dayGrid.show, true, '40 tests all on Monday is a real pattern');

  const uniform = [];
  for (let i = 0; i < 42; i++) uniform.push(i); // consecutive days = perfectly uniform weekdays
  const flat = PredictionCore.computePrediction(tests(uniform), null, daysAfter(60));
  assert.strictEqual(flat.dayGrid.show, false, 'uniform spread must not color');
  assert.match(flat.dayGrid.reason, /no significant day pattern/);
});

test('county day pattern: real pooled counts classify as weekday-service, random weekday', function() {
  // Actual production pooled counts 2026-08-21 (Sun..Sat).
  const c = PredictionCore.countyDayPattern({ dayOfWeekCounts: [0, 13, 12, 14, 21, 10, 2] });
  assert.strictEqual(c.fullWeekSignificant, true, 'weekend absence clears the full-week test');
  assert.strictEqual(c.weekdaySignificant, false, 'weekday choice is statistically random');
  assert.strictEqual(c.weekendCount, 2);
  assert.strictEqual(c.total, 72);
});

test('county day pattern: needs 30+ pooled tests', function() {
  assert.strictEqual(PredictionCore.countyDayPattern({ dayOfWeekCounts: [0, 4, 3, 4, 5, 3, 0] }), null);
  assert.strictEqual(PredictionCore.countyDayPattern(null), null);
});

test('no MUST_TEST history returns null', function() {
  assert.strictEqual(PredictionCore.computePrediction([], null, Date.now()), null);
  assert.strictEqual(
    PredictionCore.computePrediction([{ created_at: new Date().toISOString(), result: 'NO_TEST' }], null, Date.now()),
    null);
});

test('window classification: regular history earns two_number with inner+outer', function() {
  const offs = []; for (let i = 0; i <= 9; i++) offs.push(i * 20 + (i % 2));
  const w = PredictionCore.computePrediction(tests(offs), null, daysAfter(200)).window;
  assert.strictEqual(w.state, 'two_number');
  assert.ok(w.innerDays[0] >= w.outerDays[0] && w.innerDays[1] <= w.outerDays[1], 'inner within outer');
  assert.ok(w.scoredOrigins >= 3 && w.innerCoverage >= 0.7, 'self-test cleared the stability gate');
});

test('window classification: scattered history is irregular — no inner band, outer preserved', function() {
  // bittersweet-shaped: gaps 30,21,16,17,45,21,28,49,13 → self-test coverage 50%
  const w = PredictionCore.computePrediction(tests([0, 30, 51, 67, 84, 129, 150, 178, 227, 240]), null, daysAfter(250)).window;
  assert.strictEqual(w.state, 'irregular');
  assert.strictEqual(w.innerDays, null);
  assert.deepStrictEqual(w.outerDays, [13, 49]);
  assert.ok(w.innerCoverage < 0.7);
});

test('window classification: below MIN_PRIORS (5) is insufficient — no bands at all', function() {
  const w = PredictionCore.computePrediction(tests([0, 20, 40, 60]), null, daysAfter(61)).window;
  assert.strictEqual(w.state, 'insufficient');
  assert.strictEqual(w.needed, 5);
  assert.strictEqual(w.intervalsUsed, 3);
  assert.strictEqual(w.innerDays, null);
  assert.strictEqual(w.outerDays, null);
});
