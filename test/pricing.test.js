const test = require('node:test');
const assert = require('node:assert');

const { computeTieredPriceCents, MAX_EXACT_CREDITS } = require('../lib/pricing');

test('tier 1: $0.50/credit with a $5 floor', function() {
  assert.strictEqual(computeTieredPriceCents(1), 500);   // floor
  assert.strictEqual(computeTieredPriceCents(9), 500);   // floor
  assert.strictEqual(computeTieredPriceCents(10), 500);  // exactly at floor
  assert.strictEqual(computeTieredPriceCents(11), 550);
  assert.strictEqual(computeTieredPriceCents(30), 1500);
});

test('tier 2: $0.42/credit for 31-90', function() {
  assert.strictEqual(computeTieredPriceCents(31), 1542);
  assert.strictEqual(computeTieredPriceCents(90), 1500 + 60 * 42); // 4020
});

test('tier 3: $0.33/credit for 91+', function() {
  assert.strictEqual(computeTieredPriceCents(91), 4020 + 33); // 4053
  assert.strictEqual(computeTieredPriceCents(365), 4020 + 275 * 33);
});

test('invalid input returns 0 (callers must reject before checkout)', function() {
  assert.strictEqual(computeTieredPriceCents(0), 0);
  assert.strictEqual(computeTieredPriceCents(-5), 0);
  assert.strictEqual(computeTieredPriceCents(NaN), 0);
  assert.strictEqual(computeTieredPriceCents(Infinity), 0);
});

test('MAX_EXACT_CREDITS purchase still prices sanely', function() {
  var price = computeTieredPriceCents(MAX_EXACT_CREDITS);
  assert.strictEqual(price, 4020 + (MAX_EXACT_CREDITS - 90) * 33);
  assert.ok(price > 0 && price < 100000); // under $1,000 sanity bound
});
