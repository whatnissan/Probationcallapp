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

// GET /pricing hands the app the same tiers the checkout charges from, so the
// two can never disagree. This pins that: pricing a purchase from the
// published tiers must equal what computeTieredPriceCents charges.
const { creditPricing } = require('../lib/pricing');

function priceFromPublishedTiers(credits, pricing) {
  var cents = 0;
  pricing.tiers.forEach(function(t) {
    if (credits < t.fromCredit) return;
    var top = t.toCredit === null ? credits : Math.min(credits, t.toCredit);
    cents += (top - t.fromCredit + 1) * t.centsPerCredit;
  });
  return Math.max(pricing.minimumCents, cents);
}

test('published credit tiers reproduce the authoritative price for every count', function() {
  var p = creditPricing();
  assert.strictEqual(p.minimumCents, 500);
  assert.strictEqual(p.maxCredits, MAX_EXACT_CREDITS);
  assert.deepStrictEqual(p.tiers, [
    { fromCredit: 1,  toCredit: 30,   centsPerCredit: 50 },
    { fromCredit: 31, toCredit: 90,   centsPerCredit: 42 },
    { fromCredit: 91, toCredit: null, centsPerCredit: 33 }
  ]);
  for (var n = 1; n <= MAX_EXACT_CREDITS; n++) {
    assert.strictEqual(priceFromPublishedTiers(n, p), computeTieredPriceCents(n), 'credits=' + n);
  }
  assert.strictEqual(computeTieredPriceCents(95), 4185); // the contract's worked example
});

test('creditPricing returns a copy — mutating it cannot change what checkout charges', function() {
  var p = creditPricing();
  p.tiers[0].centsPerCredit = 1;
  assert.strictEqual(computeTieredPriceCents(30), 1500);
});
