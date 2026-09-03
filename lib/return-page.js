// GET /return — the page Stripe sends an app buyer to, which bounces them
// back into the iOS app. Pure so the allowlist is covered by a test.
//
// Stripe requires an http(s) return URL, so an app checkout cannot name
// probationcall:// directly. This page is the hop in between.
//
// `to` ARRIVES FROM A URL AND IS NEVER CONCATENATED INTO THE PAGE. It is
// resolved through a fixed map, so a crafted link cannot rewrite the
// button's href into an open redirect or a javascript: URL on a page we
// hand people immediately after they pay. Anything unrecognised — missing,
// misspelled, hostile — resolves to 'app', which simply opens the app.
// An ARRAY, not an object keyed by destination. An object lookup answers for
// inherited keys too: `?to=constructor` returned the Object function and
// `?to=__proto__` returned a prototype, both truthy, so `|| FALLBACK` never
// fired and the value was stringified into the button's href. A list has
// nothing to inherit.
var DESTINATIONS = ['credits', 'subscription', 'connect'];
var FALLBACK = 'app';

function resolveDestination(to) {
  var value = String(to == null ? '' : to);
  return DESTINATIONS.indexOf(value) === -1 ? FALLBACK : value;
}

function renderReturnPage(template, to) {
  return String(template).replace('__DEST__', resolveDestination(to));
}

module.exports = {
  renderReturnPage: renderReturnPage,
  resolveDestination: resolveDestination,
  DESTINATIONS: DESTINATIONS,
  FALLBACK: FALLBACK
};
