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
//   pin_expired,
//   unknown_streak,
//   null (legacy)   resume. The save — a new PIN — IS the remedy, and the
//                   website has no other way back. Untagged pauses predate
//                   any user pause, so none of them was the person's choice.
//   anything else   stays. A save never undoes a pause it does not know.
//
// `ctx` carries the facts the caller read: credits (for no_credits) and
// numberOptedOut (for sms_opted_out). A missing fact never resumes.

function resumed() { return { enabled: true, paused_reason: null }; }

function pauseStateOnSave(existing, saved, ctx) {
  ctx = ctx || {};
  // A new schedule, or one already running.
  if (!existing || existing.enabled !== false) return resumed();
  var reason = existing.paused_reason == null ? null : existing.paused_reason;
  var kept = { enabled: false, paused_reason: reason };
  switch (reason) {
    case null:
    case 'pin_expired':
    case 'unknown_streak':
      return resumed();
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

module.exports = { pauseStateOnSave: pauseStateOnSave };
