// Pricing logic, extracted verbatim from server.js so it can be
// unit-tested (test/pricing.test.js).

// Tiered pricing for the "buy exact credits" flow — single source of truth
// used by /api/calculate-credits (estimate display), /api/checkout/custom and
// /api/v1/checkout-link (actual charge), and GET /api/v1/pricing (what the
// app displays). Marginal tiers: $0.50/credit for the first 30, $0.42 for
// 31-90, $0.33 for 91+. $5 minimum (Stripe-compatible floor).
//
// The tiers are DATA, not branches, so the same array that prices a checkout
// is what the app is handed to render — a rate change here changes both, and
// the app can never show a number this function would not charge.
//
// IMPORTANT: existing credit balance does NOT discount this — pricing is
// based purely on the number of credits being purchased. The dashboard
// calculator mirrors this same formula client-side for live UX feedback,
// but the server is authoritative and recomputes here on every checkout.
var CREDIT_TIERS = [
  { fromCredit: 1,  toCredit: 30,   centsPerCredit: 50 },
  { fromCredit: 31, toCredit: 90,   centsPerCredit: 42 },
  { fromCredit: 91, toCredit: null, centsPerCredit: 33 }  // null = no upper bound
];
var MIN_PURCHASE_CENTS = 500;

function computeTieredPriceCents(credits) {
  if (!Number.isFinite(credits) || credits < 1) return 0;
  var price = 0;
  for (var i = 0; i < CREDIT_TIERS.length; i++) {
    var t = CREDIT_TIERS[i];
    if (credits < t.fromCredit) break;
    var top = t.toCredit === null ? credits : Math.min(credits, t.toCredit);
    price += (top - t.fromCredit + 1) * t.centsPerCredit;
  }
  return Math.max(MIN_PURCHASE_CENTS, price);
}

// Reasonable cap on a single exact-credits purchase. About 5 years.
// Longer probation can buy multiple times; this bounds the server-side
// trust window for client-supplied credit amounts.
var MAX_EXACT_CREDITS = 1825;

// The credit half of GET /pricing. Deep-copied so a caller cannot mutate the
// tiers that price real checkouts.
function creditPricing() {
  return {
    minimumCents: MIN_PURCHASE_CENTS,
    maxCredits: MAX_EXACT_CREDITS,
    tiers: CREDIT_TIERS.map(function(t) {
      return { fromCredit: t.fromCredit, toCredit: t.toCredit, centsPerCredit: t.centsPerCredit };
    })
  };
}

module.exports = {
  computeTieredPriceCents: computeTieredPriceCents,
  creditPricing: creditPricing,
  CREDIT_TIERS: CREDIT_TIERS,
  MIN_PURCHASE_CENTS: MIN_PURCHASE_CENTS,
  MAX_EXACT_CREDITS: MAX_EXACT_CREDITS
};
