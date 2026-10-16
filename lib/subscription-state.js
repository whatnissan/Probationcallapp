// One subscription state, whether it came from Stripe or the App Store
// (§3 `subscription`, 2026-10-15). Pure: the Stripe columns on the profile
// and the account's apple_subscriptions rows in, one answer out. Every
// server path that asks "is this person a subscriber?" goes through here, so
// an App Store subscriber is never treated as a non-subscriber by one path
// and a subscriber by another.
//
// Shape, as §3 has it, plus `source` and `duplicate`:
//   { status, cancelAtPeriodEnd, currentPeriodEnd, source: 'stripe'|'apple',
//     duplicate: null | { source, currentPeriodEnd } }
// `duplicate` is set when BOTH are active: two subscriptions, two charges a
// month. Dave's ruling: tell the person and alert him; cancel neither.

function stripeState(profile) {
  if (!profile || !(profile.subscription_status || profile.stripe_subscription_id)) return null;
  return {
    status: profile.subscription_status || null,
    cancelAtPeriodEnd: !!profile.subscription_cancel_at_period_end,
    currentPeriodEnd: profile.subscription_current_period_end || null,
    source: 'stripe'
  };
}

function appleState(row) {
  return {
    status: row.status || null,
    cancelAtPeriodEnd: row.auto_renew === false,
    currentPeriodEnd: row.expires_at || null,
    source: 'apple'
  };
}

// Which Apple row speaks for the account: an active one first, then the one
// that ends latest. Sandbox rows count only when the caller says so (the
// demo and internal accounts, whose Sandbox purchases are real for them).
function pickApple(rows, includeSandbox) {
  var list = (rows || []).filter(function(r) { return r && (includeSandbox || r.environment === 'Production'); });
  list.sort(function(a, b) {
    var aa = a.status === 'active' ? 1 : 0, ba = b.status === 'active' ? 1 : 0;
    if (aa !== ba) return ba - aa;
    return String(b.expires_at || '').localeCompare(String(a.expires_at || ''));
  });
  return list[0] || null;
}

function effectiveSubscription(profile, appleRows, opts) {
  var s = stripeState(profile);
  var ar = pickApple(appleRows, opts && opts.includeSandbox);
  var a = ar ? appleState(ar) : null;
  if (!s && !a) return null;
  if (!a) return Object.assign(s, { duplicate: null });
  if (!s) return Object.assign(a, { duplicate: null });
  if (s.status === 'active' && a.status === 'active') {
    return Object.assign(s, { duplicate: { source: 'apple', currentPeriodEnd: a.currentPeriodEnd } });
  }
  // One active: it speaks. Neither: a past_due one (still live, and the
  // person has to act on it) before an ended one; then the later end.
  var rank = function(x) { return x.status === 'active' ? 2 : x.status === 'past_due' ? 1 : 0; };
  var primary = rank(s) !== rank(a) ? (rank(s) > rank(a) ? s : a)
    : (String(a.currentPeriodEnd || '') > String(s.currentPeriodEnd || '') ? a : s);
  return Object.assign(primary, { duplicate: null });
}

// The questions other paths ask, answered from the merged state.
function isActiveSubscriber(state) {
  return !!(state && state.status === 'active');
}
function isRenewingSubscriber(state) {
  return !!(state && state.status === 'active' && !state.cancelAtPeriodEnd);
}

module.exports = {
  effectiveSubscription: effectiveSubscription,
  isActiveSubscriber: isActiveSubscriber,
  isRenewingSubscriber: isRenewingSubscriber,
  pickApple: pickApple
};
