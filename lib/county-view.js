// A person's results, seen through ONE county (Dave's rules, 2026-10-13).
// Pure — rows in, rows or summaries out — so every endpoint filters and
// labels the same way, and test/county-view.test.js pins it.
//
//   1. Nothing is deleted. Every result from every account stays, including
//      accounts that switched counties, went dormant or stopped paying.
//   2. A person's view is their CURRENT county: days since the last test,
//      gaps and patterns come only from history in the county they are in now.
//   3. Old-county history is ARCHIVED, not lost: viewable, labelled as past,
//      never mixed into the current numbers.
//
// The bug this replaces: the prediction read every row with no county
// filter, and counted a test only when `result` was 'MUST_TEST' — which is
// Montgomery's shape. Fort Bend stores the office's ANNOUNCEMENT in `result`
// ('COLOR:Gray') and the person's answer in `verdict`, so a Fort Bend test
// was never counted, and someone who moved from Montgomery to Fort Bend was
// shown their Montgomery numbers as if they were current.

var { formatLocalDay } = require('./time');

var COUNTIES = ['montgomery', 'ftbend'];

// call_history.county is set on every row (2,590 of 2,590 on 2026-10-13);
// a missing value reads as Montgomery, as everywhere else in the server.
function countyOf(row) {
  return String((row && row.county) || '').indexOf('ftbend') === 0 ? 'ftbend' : 'montgomery';
}

function normaliseCounty(c) {
  return String(c || '').indexOf('ftbend') === 0 ? 'ftbend' : 'montgomery';
}

function rowsForCounty(rows, county) {
  var want = normaliseCounty(county);
  return (rows || []).filter(function(r) { return countyOf(r) === want; });
}

// What a row MEANT for the person, as one value, whichever county wrote it:
// Montgomery's result is already the answer; Fort Bend's answer is the
// verdict recorded at call time (migration 036). A Fort Bend row with no
// verdict (written before 036) keeps its announcement string, which is not
// an answer — it is never guessed into one here.
function answerOf(row) {
  if (!row) return null;
  if (countyOf(row) === 'ftbend') {
    return row.verdict ? row.verdict : (row.result || null);
  }
  return row.result || null;
}

// Rows shaped for the prediction math, which counts result === 'MUST_TEST':
// the same rows with `result` set to the person's answer.
function asTestRows(rows) {
  return (rows || []).map(function(r) {
    return { result: answerOf(r), created_at: r.created_at };
  });
}

// One line per county the person has history in, current county first:
//   { county, current, firstDate, lastDate, results, tests }
// Dates are the county's calendar days. `tests` counts MUST_TEST answers.
function countySummaries(rows, currentCounty, tz) {
  tz = tz || 'America/Chicago';
  var cur = normaliseCounty(currentCounty);
  var by = {};
  (rows || []).forEach(function(r) {
    if (!r || !r.created_at) return;
    var c = countyOf(r);
    var s = by[c] || (by[c] = { county: c, current: c === cur, firstAt: r.created_at, lastAt: r.created_at, results: 0, tests: 0 });
    if (r.created_at < s.firstAt) s.firstAt = r.created_at;
    if (r.created_at > s.lastAt) s.lastAt = r.created_at;
    s.results++;
    if (answerOf(r) === 'MUST_TEST') s.tests++;
  });
  return COUNTIES.filter(function(c) { return by[c]; }).map(function(c) {
    var s = by[c];
    return {
      county: s.county, current: s.current,
      firstDate: formatLocalDay(new Date(s.firstAt), tz),
      lastDate: formatLocalDay(new Date(s.lastAt), tz),
      results: s.results, tests: s.tests
    };
  }).sort(function(a, b) { return (b.current - a.current) || a.county.localeCompare(b.county); });
}

module.exports = {
  COUNTIES: COUNTIES,
  countyOf: countyOf,
  normaliseCounty: normaliseCounty,
  rowsForCounty: rowsForCounty,
  answerOf: answerOf,
  asTestRows: asTestRows,
  countySummaries: countySummaries
};
