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

// The announced values a subscriber's colour is compared against, from the
// office's answer: the phase/colour groups when there are any, otherwise the
// answer itself. ONE rule — the morning fan-out and the signup-day answer
// both call this, so the two can never compare against different lists.
function todayColorsFor(result, phase1, phase2) {
  var colors = [];
  if (phase1) colors.push(String(phase1).toLowerCase());
  if (phase2) colors.push(String(phase2).toLowerCase());
  if (result && result !== 'UNKNOWN' && result !== 'PHASES' && colors.length === 0) {
    colors.push(String(result).toLowerCase());
  }
  return colors;
}

// A subscriber's verdict for one morning. ONE rule, shared by the morning
// delivery and the signup-day answer. No colour on file is NO_COLOR, never
// UNKNOWN (§2): the announcement was read, the account is missing a setting.
function verdictFor(userColor, todayColors, isUnknown) {
  if (isUnknown) return 'UNKNOWN';
  var mine = userColor ? String(userColor).toLowerCase() : null;
  if (mine && (todayColors || []).indexOf(mine) >= 0) return 'MUST_TEST';
  if (mine) return 'NO_TEST';
  return 'NO_COLOR';
}

// Today's office answer for someone whose Fort Bend schedule was created
// after it was confirmed (2026-10-02), or null. CONFIRMED means our own call
// produced it: only that path writes a recording on the office row
// (storeFtbendColor), so officeRecordingFor doubles as the confirmation —
// and as the office/date check. Never from UNKNOWN, never from a
// finishprobation-resolved day, never from another office or date.
function signupDayAnswer(dailyRow, officeId, date) {
  var recording = officeRecordingFor(dailyRow, officeId, date);
  if (!recording) return null;
  if (!dailyRow.color || String(dailyRow.color).toUpperCase() === 'UNKNOWN') return null;
  var todayColors = todayColorsFor(dailyRow.color, dailyRow.phase1_color, dailyRow.phase2_color);
  if (!todayColors.length) return null;
  return { result: dailyRow.color, todayColors: todayColors, recording: recording };
}

// The 10:00 AM Fort Bend recording check (2026-10-02), as a pure function of
// today's office rows and subscriber rows, so the rules are unit-tested and
// the job only reads and emails. Three rules, from Dave:
//   1. every office our own call resolved has its recording on the row
//      (resolved_by, migration 068; an office with no row at all is reported
//      too — its subscribers got no audio either);
//   2. wrong_office = 0: no subscriber row's audio differs from its office
//      row's;
//   3. every subscriber row has audio unless its office was resolved from
//      finishprobation.com. NO_CREDITS rows are exempt: no call was made for
//      them.
// Returns { problems: [string], summary: {...} }; no problems = clean.
function recordingCheck(officeRows, subscriberRows, names) {
  names = names || {};
  var byOffice = {};
  (officeRows || []).forEach(function(r) {
    var o = String(r.county || '').replace('ftbend_', '');
    if (OFFICES.indexOf(o) >= 0) byOffice[o] = r;
  });
  var problems = [];
  var label = function(o) { return names[o] || o; };
  // A call-resolved office: declared 'call', or (rows from before 068)
  // undeclared but carrying audio, which only the confirmed path writes.
  var byCall = function(r) { return r && (r.resolved_by === 'call' || (!r.resolved_by && !!r.recording_url)); };

  OFFICES.forEach(function(o) {
    var r = byOffice[o];
    if (!r) {
      problems.push(label(o) + ': no office row today — the office was never resolved, so none of its subscribers has audio.');
    } else if (r.resolved_by === 'call' && !r.recording_url) {
      problems.push(label(o) + ': resolved by our own call, but the office row has NO recording.');
    } else if (!r.resolved_by && !r.recording_url) {
      problems.push(label(o) + ': no recording, and no record of how it was resolved (resolved_by is empty).');
    }
  });

  var wrong = 0, missing = 0, checked = 0;
  (subscriberRows || []).forEach(function(c) {
    if (c.result === 'NO_CREDITS') return;
    checked++;
    var r = byOffice[c.ftbend_office];
    if (c.recording_url && (!r || c.recording_url !== r.recording_url)) {
      wrong++;
      problems.push('WRONG OFFICE AUDIO: subscriber ' + String(c.user_id).slice(0, 8) + ' (' + label(c.ftbend_office) + ') carries audio that is not its office row\'s.');
    } else if (!c.recording_url && byCall(r)) {
      missing++;
      problems.push('Missing audio: subscriber ' + String(c.user_id).slice(0, 8) + ' (' + label(c.ftbend_office) + ') has no recording although the office was resolved by our call.');
    }
  });

  return {
    problems: problems,
    summary: {
      offices: Object.keys(byOffice).length,
      callResolved: OFFICES.filter(function(o) { return byCall(byOffice[o]); }).length,
      subscriberRows: checked,
      wrongOffice: wrong,
      missingAudio: missing
    }
  };
}

module.exports = {
  OFFICES: OFFICES,
  recordingCheck: recordingCheck,
  classifyAnswer: classifyAnswer,
  resultStringFor: resultStringFor,
  announcementOf: announcementOf,
  groupRecent: groupRecent,
  officeRecordingFor: officeRecordingFor,
  todayColorsFor: todayColorsFor,
  verdictFor: verdictFor,
  signupDayAnswer: signupDayAnswer
};
