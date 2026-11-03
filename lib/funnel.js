// §4.14c funnel events: the pure parts. The insert lives in server.js; what a
// name and its props are allowed to be lives here so it can be tested
// without booting the server.
//
// WHITELIST, NOT A FREE-FORM LOG. An unknown name is dropped rather than
// stored, and only the listed props survive, each cut to 40 chars. A client
// typo or an accidental props blob can then never grow the table, and the
// admin summary can enumerate every name it will ever see.
//
// Nothing here is a person identifier: `src` is an app surface, and the
// props are small counters and reason strings.
var EVENTS = {
  onboarding_partner_asked: [],
  onboarding_partner_answered: ['answer'],
  onboarding_partner_left: [],
  onboarding_partner_returned: [],
  onboarding_partner_applied: ['credits'],
  onboarding_partner_not_applied: ['phase'],
  onboarding_partner_abandoned: [],
  redeem_page_open: ['src'],
  redeem_success: ['src', 'credits'],
  redeem_failed: ['src', 'reason']
};

// Every name the insert may hold. The app may only send the ones without the
// `redeem_` prefix — those are the server's own (the page beacon and the
// redemption outcomes), so a client cannot forge a success.
var APP_EVENTS = Object.keys(EVENTS).filter(function(n) { return n.indexOf('redeem_') !== 0; });

// The app-side surfaces a website visit can come from. Additive: the website
// logs the value, it never branches on it.
var SOURCES = ['ios-onboarding', 'ios-account', 'ios-buy'];

var PROP_MAX = 40;

function known(name) { return Object.prototype.hasOwnProperty.call(EVENTS, name); }
function isAppEvent(name) { return APP_EVENTS.indexOf(name) !== -1; }

function source(raw) {
  var s = String(raw == null ? '' : raw);
  return SOURCES.indexOf(s) === -1 ? null : s;
}

// Only the props this name declares, each stringified and cut. Empty and
// null values are dropped rather than stored as "null".
function props(name, raw) {
  var out = {};
  if (!raw || typeof raw !== 'object' || !known(name)) return out;
  EVENTS[name].forEach(function(k) {
    var v = raw[k];
    if (v === undefined || v === null || v === '') return;
    out[k] = String(v).slice(0, PROP_MAX);
  });
  return out;
}

module.exports = { EVENTS: EVENTS, APP_EVENTS: APP_EVENTS, SOURCES: SOURCES, PROP_MAX: PROP_MAX,
                   known: known, isAppEvent: isAppEvent, source: source, props: props };
