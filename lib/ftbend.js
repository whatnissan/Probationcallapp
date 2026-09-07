// Fort Bend announcement shaping. Pure functions, no I/O — server.js does the
// query and the caching, this decides what a row MEANS.
//
// §4.1's office board and §4.11's `recent` render the same { announced, phases }
// shape, so they must agree; two copies of this rule would drift the first time
// an office changed its recording.

// Render order on the wire. Not the dialling config — server.js's
// FTBEND_OFFICES map is that, and the two are deliberately separate.
var OFFICES = ['missouri', 'rosenberg', 'rosenberg2'];

// daily_county_status puts the announced value in phase1_color for EVERY
// office (single colours included), and Rosenberg 2 sometimes announces a
// plain colour — so classify by the VALUE, not the office: phases only when it
// actually reads "Phase N".
//
// KNOWN LIMITATION, documented in §4.11: a message announcing colours AND
// phase groups together fails the "Phase N" test and falls through to the raw
// string, so `announced` is one element holding the whole announcement. It
// occurred once in the most recent 270 rows. Splitting on commas here would
// manufacture colours the hotline never said as separate items, so the string
// is left intact and the contract tells clients not to assume one colour per
// element.
function announcementOf(b) {
  if (!b) return { announced: null, phases: null };
  var isPhases = /^phase\s/i.test(b.phase1_color || '') || /^phase\s/i.test(b.phase2_color || '');
  if (isPhases) {
    return {
      announced: null,
      phases: [b.phase1_color, b.phase2_color].filter(Boolean).map(function(p) {
        return String(p).replace(/^phase\s*/i, '');
      })
    };
  }
  return { announced: b.color ? [String(b.color).toLowerCase()] : null, phases: null };
}

// daily_county_status rows -> §4.11 `recent`, newest first.
//
// A date with no row for an office omits THAT OFFICE rather than emitting a
// null-shaped entry: §4.11 says a missing office means we captured nothing,
// and an entry with both fields null would read as an announcement of nothing.
// A date with no rows at all is simply absent, which the contract defines as
// an outage on our side — never as "no test called".
function groupRecent(rows) {
  var byDate = {};
  (rows || []).forEach(function(r) {
    if (!r || !r.date) return;
    var o = String(r.county || '').replace('ftbend_', '');
    if (OFFICES.indexOf(o) === -1) return;   // ftbend_undefined and friends
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][o] = r;
  });
  return Object.keys(byDate).sort().reverse().map(function(date) {
    return {
      date: date,
      offices: OFFICES.filter(function(o) { return byDate[date][o]; }).map(function(o) {
        var a = announcementOf(byDate[date][o]);
        return { office: o, announced: a.announced, phases: a.phases };
      })
    };
  });
}

module.exports = { OFFICES: OFFICES, announcementOf: announcementOf, groupRecent: groupRecent };
