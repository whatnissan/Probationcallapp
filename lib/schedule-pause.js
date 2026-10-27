// What a schedule SAVE does to a pause. Pure, no I/O — both writers (the
// website's POST /api/schedule and v1 PUT /schedule) call it, and
// test/schedule-pause.test.js pins every reason.
//
// Until 2026-09-30 every save forced enabled: true. That rule predates any
// user pause: the website never had a pause button, every pause was ours,
// and re-saving (usually with a new PIN) was the only way back. When §4.8
// added POST /schedule/pause the save path was never revisited, so someone
// who paused in the app and then changed how they are notified was silently
// resumed and billed, and nothing told them.
//
// The rule now: a save clears a pause only when the pause's cause is gone.
//   user            the person's choice. Stays; only POST /schedule/resume
//                   undoes it. `enabled` in a PUT body is NOT a resume — the
//                   §3 object carries it, and an app echoing it back would
//                   recreate the bug.
//   no_credits      stays at a zero balance (the top-up auto-resume owns it);
//                   with credits on the account the cause is gone.
//   sms_opted_out   resumes only if the saved channel delivers: an email
//                   method with an address, or a number not opted out.
//   pin_expired     resumes ONLY when the save carries a DIFFERENT PIN
//                   (Dave, 2026-10-06). The same PIN fails the same way: the
//                   calls would restart, report PIN_EXPIRED again (not
//                   billed, but a "checks are running" promise that is
//                   false) and re-pause a day or two later.
//   wrong_pin       the same, and for the same reason (Dave, 2026-10-28):
//                   the hotline rejected the PIN on two mornings, and only
//                   a DIFFERENT PIN can change that. Any other save leaves
//                   it paused — the streak pause it replaces was lifted by
//                   any save, on the same bad PIN.
//                   Both also lift when the schedule moves to FORT BEND
//                   (Dave, 2026-10-28): there is no PIN there to be wrong
//                   about, and nothing else could ever lift it. Coming back
//                   to Montgomery on the same PIN restores the pause
//                   (carriedPinPause), so the round trip is not a way past.
//   unknown_streak,
//   null (legacy)   resume. Untagged pauses predate any user pause, so none
//                   of them was the person's choice.
//   anything else   stays. A save never undoes a pause it does not know.
//
// `ctx` carries the facts the caller read: credits (for no_credits) and
// numberOptedOut (for sms_opted_out). A missing fact never resumes.

function resumed() { return { enabled: true, paused_reason: null }; }

// Pauses lifted only by a DIFFERENT PIN (Dave: pin_expired 2026-10-06,
// wrong_pin 2026-10-28).
var PIN_PAUSES = ['pin_expired', 'wrong_pin'];

// Pauses the person's own pause (POST /schedule/pause) must not overwrite
// (2026-10-28). Pause wrote paused_reason='user' over whatever was there,
// and Resume lifts 'user' — so pause-then-resume undid a pause whose own
// remedy is something else: a different PIN (pin_expired, wrong_pin), or a
// channel that delivers (sms_opted_out — resume refuses it for exactly that
// reason). Pausing an already-paused schedule changes nothing else, so the
// reason it has stays.
var PAUSE_KEEPS = PIN_PAUSES.concat(['sms_opted_out']);
function userPauseKeeps(existing) {
  return !!existing && existing.enabled === false && PAUSE_KEEPS.indexOf(existing.paused_reason) >= 0;
}

// A PIN put back on the line without the save that lifts a PIN pause
// (2026-10-28): a NEW schedule (the row was deleted and saved again), or a
// schedule coming back to Montgomery from Fort Bend. Either way the pause
// was gone, so the PIN the hotline had rejected was called again.
// ctx.priorPinPause is { reason, pin }: the account's last PIN pause, if no
// PIN has been accepted since, and the PIN it was about (server.js
// priorPinPauseOf). The SAME PIN comes back paused for the same reason; any
// other PIN, or none (a Fort Bend schedule), starts fresh.
function carriedPinPause(saved, ctx) {
  var prior = ctx && ctx.priorPinPause;
  if (!prior || PIN_PAUSES.indexOf(prior.reason) < 0 || prior.pin == null) return null;
  var now = saved && saved.pin != null ? String(saved.pin).trim() : '';
  if (now === '' || now !== String(prior.pin).trim()) return null;
  return { enabled: false, paused_reason: prior.reason };
}

// Whether this save puts a different PIN on the schedule. The stored PIN
// must have been read (existing.pin present, even if null): without it the
// answer is unknown, and unknown never lifts a pause or resets the count.
function pinChanged(existing, saved) {
  if (!existing || !Object.prototype.hasOwnProperty.call(existing, 'pin')) return false;
  var before = existing.pin == null ? '' : String(existing.pin).trim();
  var after = saved && saved.pin != null ? String(saved.pin).trim() : '';
  return after !== '' && after !== before;
}

function backToMontgomery(existing, saved) {
  return !!existing && existing.county === 'ftbend' && !!saved && saved.county !== 'ftbend';
}

function pauseStateOnSave(existing, saved, ctx) {
  ctx = ctx || {};
  // A new schedule — unless it re-creates a deleted one on a rejected PIN.
  if (!existing) return carriedPinPause(saved, ctx) || resumed();
  // One already running — unless it is coming back from Fort Bend on one.
  if (existing.enabled !== false) return (backToMontgomery(existing, saved) && carriedPinPause(saved, ctx)) || resumed();
  var reason = existing.paused_reason == null ? null : existing.paused_reason;
  var kept = { enabled: false, paused_reason: reason };
  switch (reason) {
    case null:
    case 'unknown_streak':
      return resumed();
    case 'pin_expired':
    case 'wrong_pin':
      return (pinChanged(existing, saved) || (saved && saved.county === 'ftbend')) ? resumed() : kept;
    case 'no_credits':
      return (typeof ctx.credits === 'number' && ctx.credits > 0) ? resumed() : kept;
    case 'sms_opted_out': {
      var m = saved && saved.notify_method;
      var emailDelivers = (m === 'email' || m === 'both') && !!saved.notify_email;
      var smsDelivers = (m === 'sms' || m === 'both') && !!saved.notify_number && ctx.numberOptedOut === false;
      return (emailDelivers || smsDelivers) ? resumed() : kept;
    }
    default:
      return kept;
  }
}

module.exports = { pauseStateOnSave: pauseStateOnSave, pinChanged: pinChanged, userPauseKeeps: userPauseKeeps, PIN_PAUSES: PIN_PAUSES };
