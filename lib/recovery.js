// Whether the hourly missed-call recovery may dial one Montgomery schedule
// now. Pure — `now` and the schedule in, a decision out — so the rules are
// unit-tested against fixed clocks (test/recovery.test.js). server.js still
// does the database checks (a call already today, a retry in flight).
//
// 2026-10-02 (found by iOS reading the scheduler): the job runs at :45 every
// hour, around the clock, and dialled any enabled schedule whose call time
// had passed with no call yet "today". It had no hotline-window check and no
// exception for a schedule created that day, so a 9 PM signup with a 6:30
// call time was dialled at 9:45 PM — outside the hotline's window — and
// billed. Two rules close that:
//
// 1. Only inside the hotline window, 06:00–14:00 county time: the schedule
//    floor (MIN_HOUR) and the retry engine's 2 PM cutoff (wouldExceedCutoff),
//    the same window every other Montgomery attempt keeps.
// 2. Never for a schedule created at or after its own call time that day.
//    Its first scheduled call is tomorrow; nothing was missed today.
//    (At the same minute counts: node-cron fires at :00 seconds, so a
//    schedule saved during its call minute has already missed it.)

var { formatLocalDay } = require('./time');

var WINDOW_START_MINUTES = 6 * 60;   // 06:00
var WINDOW_END_MINUTES = 14 * 60;    // 14:00 — 14:00 itself is allowed, 14:01 is not

function localClock(date, tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(date);
  var h = parseInt(parts.find(function(p) { return p.type === 'hour'; }).value, 10) % 24;
  var m = parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10);
  return { day: formatLocalDay(date, tz), minutes: h * 60 + m };
}

function insideHotlineWindow(now, tz) {
  var t = localClock(now, tz || 'America/Chicago').minutes;
  return t >= WINDOW_START_MINUTES && t <= WINDOW_END_MINUTES;
}

// opts.missedWindowMinutes: how long past the call time before it counts as
// missed (the stagger window + buffer, computed by the caller).
function recoveryDecision(now, sched, opts) {
  var tz = (opts && opts.tz) || 'America/Chicago';
  var missedWindow = (opts && typeof opts.missedWindowMinutes === 'number') ? opts.missedWindowMinutes : 20;
  var local = localClock(now, tz);
  if (local.minutes < WINDOW_START_MINUTES) return { dial: false, reason: 'before_window' };
  if (local.minutes > WINDOW_END_MINUTES) return { dial: false, reason: 'after_window' };

  // Same defaults the job always used for a schedule's time.
  var callMinutes = (sched.hour || 6) * 60 + (sched.minute || 0);
  if (local.minutes - callMinutes < missedWindow) return { dial: false, reason: 'not_due' };

  if (sched.created_at) {
    var created = localClock(new Date(sched.created_at), tz);
    if (created.day === local.day && created.minutes >= callMinutes) {
      return { dial: false, reason: 'created_after_call_time' };
    }
  }
  return { dial: true, reason: 'missed' };
}

module.exports = {
  insideHotlineWindow: insideHotlineWindow,
  recoveryDecision: recoveryDecision,
  WINDOW_START_MINUTES: WINDOW_START_MINUTES,
  WINDOW_END_MINUTES: WINDOW_END_MINUTES
};
