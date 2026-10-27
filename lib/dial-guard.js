// May an AUTOMATIC dial go ahead? Decided from the schedule row read at the
// moment of dialling — not from anything captured when the dial was queued.
// Pure; server.js reads the row and test/dial-guard.test.js pins the rule.
//
// 2026-10-27: pausing did not stop calls. The pause route and the STOP-reply
// pause only wrote enabled=false. Each Montgomery morning job held the
// schedule it was created with and never looked again, initiateCall checked
// nothing, and jobs were rebuilt only at restart — so a paused user was
// dialled, charged and told the result every morning until the next deploy.
// The state can change after a job, a retry or a re-dial is queued, so the
// only place the answer is reliably current is here, at dial time.
//
// Automatic dials: the morning job, the retry queue, the empty-transcript
// re-dial, missed-call recovery, the first-day call. Call Now and the admin
// trigger are someone asking for a call right now, and are not gated.
//
//   read = { error, row }  — the user_schedules read: its error, and the row
//                            (enabled, paused_reason, county, ...) or null.
//   → { dial: bool, reason: null | 'paused' | 'no_schedule' | 'read_failed' | 'county_changed', pausedReason }
//
// 'county_changed' (2026-10-28): every automatic dial this file guards is a
// Montgomery PIN call. A schedule that has since moved to Fort Bend has no
// PIN to enter and is served by the office call, so a Montgomery job or
// retry queued before the move must not dial.
//
// A READ FAILURE DIALS. If the row cannot be read, missing a morning someone
// may need to test on is the worse harm; a wrongful dial is one refundable
// credit. The caller logs it loudly.
function automaticDialDecision(read) {
  read = read || {};
  if (read.error) return { dial: true, reason: 'read_failed', pausedReason: null };
  var row = read.row;
  if (!row) return { dial: false, reason: 'no_schedule', pausedReason: null };
  if (row.enabled === false) return { dial: false, reason: 'paused', pausedReason: row.paused_reason || null };
  if (row.county === 'ftbend') return { dial: false, reason: 'county_changed', pausedReason: null };
  return { dial: true, reason: null, pausedReason: null };
}

// WHAT an automatic dial uses: the schedule as it is NOW, not the copy taken
// when the dial was queued (2026-10-28). A queued retry carried its own PIN,
// hotline number and notification details, and nothing updated them — so
// someone who fixed a mistyped PIN at 7 AM was dialled on the old one until
// the 2 PM cutoff and then told nothing had worked. Reading here, where the
// dial happens, covers the morning job, the retry queue, the
// empty-transcript re-dial, recovery and the first-day call at once, with
// no writer having to remember to update a queued copy.
//
// The live row wins field by field for the notification details, as stored
// (a cleared email is cleared; notify_method decides which one is used).
// PIN and hotline number fall back to the queued values only when the row
// has none — a call cannot be placed without them. A failed read (row null)
// dials exactly what was queued.
//   queued = { targetNumber, pin, notifyNumber, notifyEmail, notifyMethod }
function liveDialParams(queued, row) {
  queued = queued || {};
  if (!row) return Object.assign({}, queued);
  var has = function(v) { return v !== null && v !== undefined && String(v).trim() !== ''; };
  return {
    targetNumber: has(row.target_number) ? row.target_number : queued.targetNumber,
    pin: has(row.pin) ? String(row.pin).trim() : queued.pin,
    notifyNumber: row.notify_number || null,
    notifyEmail: row.notify_email || null,
    notifyMethod: row.notify_method || queued.notifyMethod
  };
}

// The columns both of the above need, for the one read in initiateCall.
var LIVE_COLUMNS = 'enabled, paused_reason, county, pin, target_number, notify_number, notify_email, notify_method';

module.exports = { automaticDialDecision: automaticDialDecision, liveDialParams: liveDialParams, LIVE_COLUMNS: LIVE_COLUMNS };
