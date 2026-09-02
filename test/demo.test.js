const test = require('node:test');
const assert = require('node:assert');
const { demoMorningResult, seedDemoHistory, CYCLE, DEMO_PIN } = require('../lib/demo');
const { PredictionCore } = require('../public/prediction-core.js');

const NOW = new Date('2026-09-02T14:00:00Z');

test('seeded demo history: 84 mornings, required tests on the fixed cycle, a few UNKNOWNs, never dials', function() {
  var rows = seedDemoHistory('demo-user', '+19365551234', 84, NOW);
  assert.strictEqual(rows.length, 84);
  var musts = rows.filter(function(r) { return r.result === 'MUST_TEST'; });
  assert.ok(musts.length >= 6 && musts.length <= 8, 'got ' + musts.length + ' required tests');
  for (var i = 1; i < musts.length; i++) {
    var gap = Math.round((new Date(musts[i].created_at) - new Date(musts[i - 1].created_at)) / 86400000);
    assert.strictEqual(gap, CYCLE[i % CYCLE.length]);
  }
  assert.ok(rows.some(function(r) { return r.result === 'UNKNOWN'; }));
  var withRec = rows.filter(function(r) { return r.recording_url; });
  assert.strictEqual(withRec.length, 1, 'exactly one synthetic recording');
  assert.strictEqual(withRec[0].recording_url, 'demo:hotline-sample');
  assert.strictEqual(withRec[0].result, 'MUST_TEST');
  assert.strictEqual(withRec[0], musts[musts.length - 1], 'on the most recent required test');
  rows.forEach(function(r) {
    assert.ok(!r.recording_url || r.recording_url.indexOf('demo:') === 0, 'never a Twilio URL');
    assert.strictEqual(r.county, 'montgomery');
    assert.strictEqual(r.pin_used, DEMO_PIN);
    assert.strictEqual(!!r.billed_at, r.result === 'MUST_TEST' || r.result === 'NO_TEST');
    assert.ok(r.transcript && r.transcript.length > 40);
  });
});

test('the cron continues the seed: the next morning is what the seed would have produced', function() {
  var rows = seedDemoHistory('demo-user', '+1', 84, NOW);
  var next = demoMorningResult(rows, NOW);
  var longer = seedDemoHistory('demo-user', '+1', 85, new Date(NOW.getTime() + 86400000));
  assert.strictEqual(next.result, longer[84].result);
});

test('120 mornings of demo history clears the five-interval gate and earns a two_number window', function() {
  var rows = seedDemoHistory('demo-user', '+1', 120, NOW);
  var p = PredictionCore.computePrediction(rows, null, NOW.getTime());
  assert.ok(p.usedIntervals >= 8, 'intervals: ' + p.usedIntervals);
  assert.strictEqual(p.window.state, 'two_number');
  assert.ok(p.daysSince <= 15, 'never drifts past its own range: ' + p.daysSince);
});

test('first morning ever is a required test; UNKNOWN only on the 13th and 27th', function() {
  assert.strictEqual(demoMorningResult([], NOW).result, 'MUST_TEST');
  var rows = [{ result: 'MUST_TEST', created_at: '2026-09-10T10:05:00Z' }];
  assert.strictEqual(demoMorningResult(rows, new Date('2026-09-13T10:05:00Z')).result, 'UNKNOWN');
  assert.strictEqual(demoMorningResult(rows, new Date('2026-09-14T10:05:00Z')).result, 'NO_TEST');
});

test('the demo PIN is outside every observed PIN shape and travels on every seeded row', function() {
  // Real Montgomery PINs we hold: first digit 1-9, no repeated digit (0 of 17
  // at 2026-09-02). Six zeroes is as far outside that as a 6-digit value gets,
  // and initiateCall refuses to dial this exact value (tripwire) regardless
  // of what profiles.is_demo says.
  assert.strictEqual(DEMO_PIN, '000000');
  assert.ok(/^(\d)\1{5}$/.test(DEMO_PIN));
  var rows = seedDemoHistory('demo-user', '+1', 30, NOW);
  rows.forEach(function(r) { assert.strictEqual(r.pin_used, DEMO_PIN); });
  rows.forEach(function(r) { assert.ok(r.transcript.indexOf('four eight two') < 0, 'transcripts must not read out a PIN'); });
});
