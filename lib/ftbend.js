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
// THE classifier. One rule, one place, used by the office board (§4.11), by
// §4.1, and by the per-user call row — which until 2026-09-29 chose its
// format from the OFFICE instead: Rosenberg 2 is flagged as a phases office,
// so a day it announced a plain colour was written 'P1:Gray P2:?'.
//
// `answer` is the cross-checked announcement: a string as stored
// ('Gray', 'Phase 1 B, Phase 5') or the array it was joined from. Phases
// only when a part actually reads "Phase N" — 'Prep Phase 1' is a program
// designation the catalogue carries as a value, so it stays an announced
// value and does not become a phase group.
function classifyAnswer(answer) {
  var parts = (Array.isArray(answer) ? answer : String(answer == null ? '' : answer).split(','))
    .map(function(p) { return String(p == null ? '' : p).trim(); })
    .filter(function(p) { return p.length > 0 && p.toUpperCase() !== 'UNKNOWN'; });
  if (!parts.length) return { announced: null, phases: null };
  // EVERY part, not any: the §4.11 limitation. A message that names colours
  // AND phase groups together ("Gray, Lemon, Prep, Phase 1, ...", seen once)
  // is not a phase announcement, and splitting it would invent colours the
  // hotline never announced as separate items. Such a message stays ONE
  // announced element holding the whole string, which is what the contract
  // tells clients to expect — and what this did before the classifier moved.
  var allPhases = parts.every(function(p) { return /^phase\b/i.test(p); });
  if (allPhases) {
    return {
      announced: null,
      phases: parts.map(function(p) { return p.replace(/^phase\s*/i, '').trim(); })
        .filter(function(p) { return p.length > 0; })
    };
  }
  var whole = parts.join(', ').toLowerCase();
  return { announced: [whole], phases: null };
}

// The stored result string for one Fort Bend morning, from the same
// classification. A one-value phase day is 'P1:Phase 2' with no second
// segment — never 'P2:?', which is not a phase group and never was.
function resultStringFor(answer) {
  var c = classifyAnswer(answer);
  if (c.phases) {
    return c.phases.map(function(p, i) { return 'P' + (i + 1) + ':Phase ' + p; }).join(' ');
  }
  if (c.announced) {
    var raw = (Array.isArray(answer) ? answer.join(', ') : String(answer)).trim();
    return 'COLOR:' + raw;
  }
  return 'UNKNOWN';
}

// A daily_county_status row -> { announced, phases }. `color` holds the
// cross-checked answer and is what the subscriber was told, so it leads.
// The phase columns are the fallback for a row whose colour never resolved,
// and they are NOT authoritative: they come from raw detection with no
// ground-truth cross-check, which is why five September rows have a colour
// and a null phase1_color (Nickel and Iron were missing from the detector's
// vocabulary, Pink was heard as "Ping").
function announcementOf(b) {
  if (!b) return { announced: null, phases: null };
  var fromAnswer = classifyAnswer(b.color);
  if (fromAnswer.announced || fromAnswer.phases) return fromAnswer;
  return classifyAnswer([b.phase1_color, b.phase2_color]);
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

// What one subscriber's Fort Bend row may carry from an office's daily row:
// the recording AND the transcript of the office call, together, or neither
// (§4.4, 2026-10-01). One office call serves every subscriber at that office
// — Fort Bend hotline audio has no PIN and nothing personal — but a
// recording from the WRONG office on a result screen is worse than none, so
// this refuses anything it cannot tie to the subscriber's office and date,
// even though the caller's query already filters on both.
//
// No recording_url means the office was resolved without a call of our own
// (finishprobation.com after our calls failed). Its transcript is then not
// ours to present as a recording's, so nothing is copied.
function officeRecordingFor(dailyRow, officeId, date) {
  if (!dailyRow || !officeId || !date) return null;
  if (OFFICES.indexOf(officeId) === -1) return null;
  if (dailyRow.county !== 'ftbend_' + officeId) return null;
  if (String(dailyRow.date) !== String(date)) return null;
  if (!dailyRow.recording_url) return null;
  return {
    recording_url: dailyRow.recording_url,
    recording_duration_seconds: typeof dailyRow.recording_duration_seconds === 'number'
      ? dailyRow.recording_duration_seconds : null,
    transcript: dailyRow.transcript || null
  };
}

module.exports = {
  OFFICES: OFFICES,
  classifyAnswer: classifyAnswer,
  resultStringFor: resultStringFor,
  announcementOf: announcementOf,
  groupRecent: groupRecent,
  officeRecordingFor: officeRecordingFor
};
