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
//                            (enabled, paused_reason) or null.
//   → { dial: bool, reason: null | 'paused' | 'no_schedule' | 'read_failed', pausedReason }
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
  return { dial: true, reason: null, pausedReason: null };
}

module.exports = { automaticDialDecision: automaticDialDecision };
