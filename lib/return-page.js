// GET /return — the page every app payment flow ends on, in real Safari:
// Stripe Checkout (success and cancel, subscription and credits), the Stripe
// billing portal, and Connect onboarding. Pure so the allowlists and the copy
// rules are covered by test/return-page.test.js.
//
// Stripe requires an http(s) return URL, so an app checkout cannot name
// probationcall:// directly. This page is the hop in between, and it has to
// make sense on its own: it says what happened, offers ONE clear "Back to
// ProbationCall" button, and tells someone without the app where to go.
//
// NOTHING FROM THE URL IS CONCATENATED INTO THE PAGE. `to`, `result` and
// `from` are resolved through fixed lists; a session id is accepted only in
// Stripe's own shape, and is used to ASK Stripe, never echoed. Every visible
// sentence is one of the fixed strings below, with at most a number we
// computed. A crafted link therefore cannot rewrite the button into an open
// redirect or a javascript: URL on a page handed to someone right after
// they pay.
//
// Lists, not objects keyed by value: an object lookup answers for inherited
// keys too (`?to=constructor` returned the Object function, `?to=__proto__`
// a prototype), both truthy, so a fallback never fired.
var DESTINATIONS = ['credits', 'subscription', 'connect'];
var FALLBACK = 'app';
var RESULTS = ['success', 'canceled'];
var SOURCES = ['portal'];
var SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;

function pick(list, value) {
  var v = String(value == null ? '' : value);
  return list.indexOf(v) === -1 ? null : v;
}

function resolveDestination(to) {
  return pick(DESTINATIONS, to) || FALLBACK;
}

// What the URL says, reduced to values this module produced itself.
function parseReturnQuery(query) {
  var q = query || {};
  var sid = typeof q.session_id === 'string' && SESSION_ID.test(q.session_id) ? q.session_id : null;
  return {
    dest: resolveDestination(q.to),
    result: pick(RESULTS, q.result),
    from: pick(SOURCES, q.from),
    sessionId: sid,
    // Set on the one automatic reload a pending grant gets, so it reloads once.
    again: q.again === '1'
  };
}

function plural(n) { return n === 1 ? '' : 's'; }

// The page's words. `facts` is what the server VERIFIED with Stripe and our
// own ledger for this checkout, or null when it could not (no session id, a
// Stripe error, the lookup limit). A success is only ever claimed from facts:
// Stripe sends people here the moment they finish, which can be before our
// webhook has granted anything, so "added" is said only once the ledger row
// exists, and "payment received" only once Stripe says paid.
//   facts = { paid: bool, kind: 'credits'|'subscription', credits: int, granted: bool }
function viewFor(q, facts) {
  var dest = q.dest;
  var v = { title: 'Back to ProbationCall', heading: 'Back to ProbationCall', message: '', pending: false };

  if (q.from === 'portal') {
    v.heading = 'Subscription settings closed';
    v.message = 'Any change you made is saved with Stripe. The app shows your current plan.';
    return v;
  }
  if (dest === 'connect') {
    v.heading = 'Payout setup';
    v.message = 'The app shows whether your payout account is ready.';
    return v;
  }
  if (q.result === 'canceled') {
    v.title = v.heading = 'Checkout canceled';
    v.message = 'Nothing was charged.';
    return v;
  }
  if (q.result === 'success' && facts && facts.paid && facts.credits > 0) {
    var n = facts.credits;
    if (facts.kind === 'subscription') {
      v.title = 'Subscription started';
      v.heading = facts.granted ? 'Subscription started — ' + n + ' credits added' : 'Subscription started';
      v.message = facts.granted
        ? 'You get ' + n + ' credits every month it renews. You can cancel any time from the app.'
        : 'Your first ' + n + ' credits are being added. They will show in the app within a minute.';
    } else {
      v.title = facts.granted ? n + ' credit' + plural(n) + ' added' : 'Payment received';
      v.heading = v.title;
      v.message = facts.granted
        ? 'Your payment went through and the credit' + plural(n) + ' ' + (n === 1 ? 'is' : 'are') + ' on your account.'
        : 'Your ' + n + ' credit' + plural(n) + ' ' + (n === 1 ? 'is' : 'are') + ' being added. They will show in the app within a minute.';
    }
    v.pending = !facts.granted;
    return v;
  }
  if (q.result === 'success' && facts && !facts.paid) {
    v.title = v.heading = 'Payment not finished';
    v.message = 'Stripe has not confirmed this payment, and nothing has been added. You can try again from the app.';
    return v;
  }
  if (dest === 'credits' || dest === 'subscription') {
    // A checkout return we could not verify (an old link without a session
    // id, or Stripe did not answer). Say only what is certainly true.
    v.message = 'If your payment went through, your credits will show in the app shortly.';
    return v;
  }
  v.message = 'Tap the button to return to the app.';
  return v;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// One automatic reload, five seconds on, while a verified payment's grant
// has not landed yet — so the page catches up to "added" by itself. The URL
// is rebuilt from validated values only.
function refreshTag(q, view) {
  if (!view.pending || q.again || !q.sessionId) return '';
  var url = '/return?to=' + q.dest + '&result=success&session_id=' + q.sessionId + '&again=1';
  return '<meta http-equiv="refresh" content="5;url=' + escapeHtml(url) + '">';
}

function renderReturnPage(template, query, facts) {
  // Callers that still pass a bare `to` string get the generic page.
  var q = typeof query === 'object' && query !== null ? parseReturnQuery(query) : parseReturnQuery({ to: query });
  var view = viewFor(q, facts || null);
  return String(template)
    .replace('__REFRESH__', refreshTag(q, view))
    .replace('__TITLE__', escapeHtml(view.title === 'Back to ProbationCall' ? view.title : view.title + ' - ProbationCall'))
    .replace('__HEADING__', escapeHtml(view.heading))
    .replace('__MESSAGE__', escapeHtml(view.message))
    .replace('__DEST__', q.dest);
}

module.exports = {
  renderReturnPage: renderReturnPage,
  resolveDestination: resolveDestination,
  parseReturnQuery: parseReturnQuery,
  viewFor: viewFor,
  DESTINATIONS: DESTINATIONS,
  FALLBACK: FALLBACK,
  SESSION_ID: SESSION_ID
};
