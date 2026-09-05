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
  // count + opportunities, never a multiplier — 4.10 bans lift/timesAverage.
  assert.strictEqual(r.days[0].count, 22);
  assert.strictEqual(r.days[0].opportunities, 208);
  assert.ok(!('lift' in r.days[0]) && !('timesAverage' in r.days[0]), 'no multiplier may be emitted');
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

// ---- gapBand: the shortest contiguous band (§4.10 countyDaily) ----
const { shortestBandOf } = PredictionCore;

// Canonical pool, 65 completed intervals across 16 users.
const POOL = [
  [1],[2,4,5],[5,5,6,7],[7,7,7,8],[8,8,9,9,10],[11,11,11,11,13],[13,13,13,13,13],
  [14,16,16,17,17],[18,18,19,19,21],[21,21,22,24,24],[25,25,26,26,27],[28,28,29,29,30],
  [31,32,36,38,42],[45,49,49,49],[50,52,57],[63]
];

test('the shortest 80% band is narrower than the central one, on the real pool', function() {
  const b = shortestBandOf(POOL, 0.8);
  assert.strictEqual(b.lowDays, 4);
  assert.strictEqual(b.highDays, 32);
  assert.strictEqual(b.mass, 0.8);
  assert.strictEqual(b.basedOnIntervals, 65);
  // The central band over the same pool is 5-47 (width 42). Shortest is 28.
  assert.ok((b.highDays - b.lowDays) < 42, 'shortest must beat central width');
});

// mass is the CONSTRUCTION parameter. Nothing here measures coverage, and
// §4.10 forbids presenting it as such — so no coverage key may escape.
test('gapBand emits no coverage figure of any kind', function() {
  const b = shortestBandOf(POOL, 0.8);
  const keys = Object.keys(b).join(',');
  assert.ok(!/coverage|accuracy|confidence|probability/i.test(keys), 'keys: ' + keys);
  assert.deepStrictEqual(Object.keys(b).sort(),
    ['basedOnIntervals','basedOnUsers','highDays','lowDays','mass']);
});

test('gapBand endpoints are observed values, and it refuses a thin pool', function() {
  const b = shortestBandOf(POOL, 0.8);
  const flat = POOL.flat();
  assert.ok(flat.includes(b.lowDays) && flat.includes(b.highDays), 'endpoints are real observations');
  // Below the 20-interval / 3-user gate the county fact is not measurable.
  assert.strictEqual(shortestBandOf([[5,10],[12,14]], 0.8), null);
  assert.strictEqual(shortestBandOf([], 0.8), null);
});

test('a higher mass cannot produce a narrower band', function() {
  const w = m => { const b = shortestBandOf(POOL, m); return b.highDays - b.lowDays; };
  assert.ok(w(0.9) >= w(0.85) && w(0.85) >= w(0.8), '80:' + w(0.8) + ' 85:' + w(0.85) + ' 90:' + w(0.9));
});
