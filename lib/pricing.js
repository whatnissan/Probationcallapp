// Pricing logic, extracted verbatim from server.js so it can be
// unit-tested (test/pricing.test.js).

// Tiered pricing for the "buy exact credits" flow — single source of truth
// used by /api/calculate-credits (estimate display) AND /api/checkout/custom
// (actual charge). Tiers: $0.50/credit for the first 30, $0.42 for 31-90,
// $0.33 for 91+. $5 minimum (Stripe-compatible floor).
//
// IMPORTANT: existing credit balance does NOT discount this — pricing is
// based purely on the number of credits being purchased. The dashboard
// calculator mirrors this same formula client-side for live UX feedback,
// but the server is authoritative and recomputes here on every checkout.
function computeTieredPriceCents(credits) {
  if (!Number.isFinite(credits) || credits < 1) return 0;
  var price;
  if (credits <= 30) {
    price = credits * 50;
  } else if (credits <= 90) {
    price = (30 * 50) + ((credits - 30) * 42);
  } else {
    price = (30 * 50) + (60 * 42) + ((credits - 90) * 33);
  }
  return Math.max(500, price);
}

// Reasonable cap on a single exact-credits purchase. About 5 years.
// Longer probation can buy multiple times; this bounds the server-side
// trust window for client-supplied credit amounts.
var MAX_EXACT_CREDITS = 1825;

module.exports = {
  computeTieredPriceCents: computeTieredPriceCents,
  MAX_EXACT_CREDITS: MAX_EXACT_CREDITS
};
