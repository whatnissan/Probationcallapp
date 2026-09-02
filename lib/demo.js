// The App Review demo account (2026-09-02). One rule, used by both the seed
// script and the morning cron: given the account's call history and today's
// date, what result does this morning produce? Deterministic, so the
// history the reviewer sees is the history the cron continues — and so it
// never drifts into the past-range state however long review takes.
//
// The account never dials. profiles.is_demo makes the scheduler write the
// row this module returns instead of calling Twilio, and keeps the account
// out of every pooled statistic (county range, county stats, funnel).
var CYCLE = [13, 15, 12, 14, 13, 15, 14, 12]; // days between required tests; regular enough to earn two_number
var UNKNOWN_DAYS_OF_MONTH = [13, 27];         // two unparseable mornings a month, for realism
// Six zeroes on purpose. No real Montgomery PIN we hold starts with 0 or
// repeats one digit (0 of 17), so this is as far outside the observed
// namespace as a 6-digit value can be — and initiateCall carries a tripwire
// that refuses to dial it at all, so the value never reaches the hotline
// even if the is_demo flag were lost. Nothing else identifies the account.
var DEMO_PIN = '000000';
// One synthetic recording so the History playback screen has something to
// play. Audio WE made (macOS speech synthesis reading the MUST_TEST
// transcript, plus "this is a demonstration recording") — never a real
// hotline capture. 'demo:' is a scheme the recording endpoints recognise and
// the 30-day Twilio cleanup skips; the file lives at public/demo/.
var DEMO_RECORDING_URL = 'demo:hotline-sample';
var DEMO_RECORDING_FILE = '/demo/hotline-sample.m4a';
var DEMO_RECORDING_SECONDS = 13;

var TRANSCRIPTS = {
  MUST_TEST: 'Thank you for calling the Montgomery County probation testing line. Today is a testing day. Client, you are required to report for testing today. Please report before four p.m.',
  NO_TEST: 'Thank you for calling the Montgomery County probation testing line. Client, you are not required to report for testing today. Please call again tomorrow.',
  UNKNOWN: 'Thank you for calling the Montgomery County probation testing line. Please hold for the ... [inaudible] ... call again.'
};

function dayKey(d) { return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

// rows: call_history-shaped objects with result and created_at. today: Date.
function demoMorningResult(rows, today) {
  var musts = (rows || []).filter(function(r) { return r.result === 'MUST_TEST'; })
    .map(function(r) { return new Date(r.created_at); }).sort(function(a, b) { return a - b; });
  var todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  var result;
  if (!musts.length) {
    result = 'MUST_TEST';
  } else {
    var last = musts[musts.length - 1];
    var lastStart = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate()));
    var nextGap = CYCLE[musts.length % CYCLE.length];
    if (daysBetween(lastStart, todayStart) >= nextGap) result = 'MUST_TEST';
    else if (UNKNOWN_DAYS_OF_MONTH.indexOf(today.getUTCDate()) >= 0) result = 'UNKNOWN';
    else result = 'NO_TEST';
  }
  return { result: result, transcript: TRANSCRIPTS[result], billable: result === 'MUST_TEST' || result === 'NO_TEST' };
}

// A call_history row for one demo morning at 05:05 America/Chicago-ish (we
// stamp 10:05Z, which is 05:05 CDT / 04:05 CST — close enough for a demo).
function demoRow(userId, targetNumber, date, outcome) {
  var at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 10, 5, 0));
  return {
    user_id: userId,
    call_sid: 'DEMO' + dayKey(at).replace(/-/g, ''),
    target_number: targetNumber,
    pin_used: DEMO_PIN,
    result: outcome.result,
    transcript: outcome.transcript,
    recording_url: null,
    recording_duration_seconds: null,
    county: 'montgomery',
    billed_at: outcome.billable ? at.toISOString() : null,
    created_at: at.toISOString()
  };
}

// Seed: `days` consecutive mornings ending yesterday (relative to `now`).
function seedDemoHistory(userId, targetNumber, days, now) {
  var rows = [];
  var end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (var i = days; i >= 1; i--) {
    var d = new Date(end.getTime() - i * 86400000);
    rows.push(demoRow(userId, targetNumber, d, demoMorningResult(rows, d)));
  }
  // The most recent required-test morning carries the synthetic recording.
  for (var j = rows.length - 1; j >= 0; j--) {
    if (rows[j].result === 'MUST_TEST') {
      rows[j].recording_url = DEMO_RECORDING_URL;
      rows[j].recording_duration_seconds = DEMO_RECORDING_SECONDS;
      break;
    }
  }
  return rows;
}

module.exports = {
  demoMorningResult: demoMorningResult,
  demoRow: demoRow,
  seedDemoHistory: seedDemoHistory,
  DEMO_PIN: DEMO_PIN,
  DEMO_RECORDING_URL: DEMO_RECORDING_URL,
  DEMO_RECORDING_FILE: DEMO_RECORDING_FILE,
  DEMO_RECORDING_SECONDS: DEMO_RECORDING_SECONDS,
  CYCLE: CYCLE
};
