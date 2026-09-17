// Terms of Service versions and the acceptance rule (§3 terms, §4.20).
// Pure; server.js does the I/O. Unit-tested in test/terms.test.js, which
// also PINS CURRENT_VERSION to the Last Updated date printed on
// public/terms.html — the page and this constant drifted once (the
// 2026-08-24 WhatsApp edit changed the text and not the date), and a record
// that names a version the page does not show is not a record.
//
// A version is the page's Last Updated date, YYYY-MM-DD.
//   CURRENT_VERSION  — the text /terms serves today. Bump it with ANY edit
//                      to the page's text, and change the page date with it.
//   REQUIRED_VERSION — the oldest acceptance that still counts. Move it
//                      ONLY when an edit changes what a person agrees to
//                      (the liability waiver, assumption of risk,
//                      no-accuracy guarantee, indemnification, or anything
//                      else material). Moving it re-prompts every account
//                      on an older version.

var CURRENT_VERSION = '2026-08-24';
var REQUIRED_VERSION = '2025-12-04';

// When each text went live. Used only to explain the backfill; the
// migration carries the same boundary.
var VERSION_HISTORY = [
  { version: '2025-12-04', commit: '7a58659', note: 'original Terms of Service' },
  { version: '2026-08-24', commit: '6e93109', note: 'WhatsApp removed from the service description; none of the four clauses changed' }
];

function isVersionString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  var d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// YYYY-MM-DD strings compare correctly as strings.
function needsAcceptance(acceptedVersion, requiredVersion) {
  if (!acceptedVersion) return true;
  return String(acceptedVersion) < String(requiredVersion || REQUIRED_VERSION);
}

// The /me object from the newest acceptance on file (or none).
function termsPayload(latest) {
  var v = latest && latest.terms_version ? latest.terms_version : null;
  return {
    currentVersion: CURRENT_VERSION,
    requiredVersion: REQUIRED_VERSION,
    acceptedVersion: v,
    acceptedAt: v ? (latest.accepted_at || null) : null,
    needsAcceptance: needsAcceptance(v, REQUIRED_VERSION)
  };
}

var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// "Last Updated: August 24, 2026" anywhere in the page → '2026-08-24'.
// Null when the page carries no parseable Last Updated date.
function lastUpdatedFromTermsHtml(html) {
  var m = /Last Updated:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(html || ''));
  if (!m) return null;
  var mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  var v = m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
  return isVersionString(v) ? v : null;
}

module.exports = {
  CURRENT_VERSION: CURRENT_VERSION,
  REQUIRED_VERSION: REQUIRED_VERSION,
  VERSION_HISTORY: VERSION_HISTORY,
  isVersionString: isVersionString,
  needsAcceptance: needsAcceptance,
  termsPayload: termsPayload,
  lastUpdatedFromTermsHtml: lastUpdatedFromTermsHtml
};
