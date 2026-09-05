const test = require('node:test');
const assert = require('node:assert');
const { PredictionCore } = require('../public/prediction-core');
const { countyElevatedDays } = PredictionCore;

// Measured 2026-09-04 over 2,054 calls, Montgomery, demo/internal excluded.
// Index 0 = Sunday.
const MUSTS = [0, 11, 10, 16, 22, 10, 3];
const CALLS = [208, 212, 212, 208, 208, 214, 207];

test('it names Thursday and nothing else on the real county data', function() {
  const r = countyElevatedDays(MUSTS, CALLS);
  assert.strictEqual(r.show, true);
  assert.deepStrictEqual(r.days.map(d => d.day), [4], 'Thursday only');
  assert.ok(r.days[0].lift > 2, 'Thursday runs >2x the average day');
  // Wednesday is 7.7% vs 4.9% overall and still must NOT appear: it does not
  // survive Bonferroni across 7 days, and a weak day named alongside a strong
  // one spends the credibility of both.
  assert.ok(!r.days.some(d => d.day === 3), 'Wednesday does not clear the per-day test');
});

// THE RULE THIS FILE EXISTS FOR. A user who reads "Sunday is 0 of 208",
// relaxes, and is called on a Sunday was failed by this app. No sample size
// converts "not yet observed" into "safe".
test('a below-average day can NEVER be returned, whatever the data', function() {
  const r = countyElevatedDays(MUSTS, CALLS);
  const overall = r.overallRate;
  r.days.forEach(d => assert.ok(d.rate > overall, 'day ' + d.day + ' is above average'));
  // Sunday has the strongest "signal" in the whole set — zero in 208 — and is
  // exactly what must never surface.
  assert.ok(!r.days.some(d => d.day === 0), 'Sunday must never appear');
  assert.ok(!r.days.some(d => d.day === 6), 'Saturday (1.4%) must never appear');

  // Invert the data: the quiet days become loud. Still nothing below average.
  const inverted = [22, 10, 10, 3, 0, 11, 16];
  const r2 = countyElevatedDays(inverted, CALLS);
  r2.days.forEach(d => assert.ok(d.rate > r2.overallRate));
  assert.ok(!r2.days.some(d => d.day === 4), 'now-quiet Thursday must not appear');
});

test('the return value cannot be rendered as a seven-day gradient', function() {
  const r = countyElevatedDays(MUSTS, CALLS);
  assert.ok(Array.isArray(r.days));
  assert.ok(r.days.length < 7, 'never a full week');
  // No key anywhere in the payload holds a 7-element series.
  const seven = JSON.stringify(r).match(/\[[^\]]*\]/g) || [];
  seven.forEach(a => {
    const n = a.split(',').length;
    assert.ok(n < 7, 'no 7-element array may escape: ' + a.slice(0, 60));
  });
});

test('it refuses to speak on thin or flat data', function() {
  // Below the pooled-tests floor.
  assert.strictEqual(countyElevatedDays([1,1,1,1,2,1,1], CALLS).show, false);
  // Plenty of tests, but spread evenly — no weekday pattern to report.
  const flat = [10, 10, 10, 10, 10, 10, 10];
  const rf = countyElevatedDays(flat, CALLS);
  assert.strictEqual(rf.show, false);
  assert.match(rf.reason, /no significant weekday pattern/);
  // Malformed input is refused, not guessed at.
  assert.strictEqual(countyElevatedDays(null, null).show, false);
  assert.strictEqual(countyElevatedDays([1,2], [1,2]).show, false);
});

test('a weekday with too few calls behind it cannot be named', function() {
  // Thursday looks extreme but rests on 12 calls — not enough denominator.
  const thin = [0, 11, 10, 16, 8, 10, 3];
  const thinCalls = [208, 212, 212, 208, 12, 214, 207];
  const r = countyElevatedDays(thin, thinCalls);
  assert.ok(!r.days.some(d => d.day === 4), 'a thin denominator cannot earn a claim');
});
