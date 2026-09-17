// Dial-time spacing for Montgomery per-user calls. Pure; server.js does the
// I/O. Unit-tested in test/stagger.test.js.
//
// Until 2026-09-17 every user got a fixed offset from a hash of their id,
// anywhere in 0–15 minutes, forever. One subscriber sat at +13m16s on a
// 06:00 call time through no fault of his own, and eleven schedules never
// needed a 15-minute spread. Now: users sharing a call time (a "cohort")
// dial in creation order, CALL_STAGGER_SECONDS apart. Joining a cohort puts
// you at the back and moves nobody.
//
// The spacing default is 45 s, not 20: a Montgomery recording runs 35–38 s
// plus setup, so 45 s means one of our calls is fully off the line before
// the next dials. The hotline's line count is unknown and 371 dials on
// record never overlapped, so we do not put two of our own calls on it
// until call_attempts shows we can. Dropping to 20 is a Railway edit.

var DEFAULT_SPACING_SECONDS = 45;

function spacingSecondsFrom(envValue) {
  var n = parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPACING_SECONDS;
}

// Members of one cohort in dial order: creation time, then id as a
// tie-break so the order is total and identical on every server.
function cohortOrder(members) {
  return members.slice().sort(function(a, b) {
    var ta = a.created_at ? Date.parse(a.created_at) : 0;
    var tb = b.created_at ? Date.parse(b.created_at) : 0;
    if (ta !== tb) return ta - tb;
    return String(a.user_id) < String(b.user_id) ? -1 : String(a.user_id) > String(b.user_id) ? 1 : 0;
  });
}

// Delay in ms for one user given the cohort. A user not in the list (paused
// between the query and now, or a race) dials at +0 rather than never.
function cohortDelayMs(userId, members, spacingSeconds) {
  var order = cohortOrder(members);
  var rank = 0;
  for (var i = 0; i < order.length; i++) {
    if (String(order[i].user_id) === String(userId)) { rank = i; break; }
  }
  return rank * spacingSeconds * 1000;
}

// Largest cohort across a schedule list: how many users share the busiest
// call time. Fort Bend rows never dial per user and are skipped.
function maxCohortSize(schedules) {
  var counts = {};
  var max = 0;
  (schedules || []).forEach(function(s) {
    if (!s || s.county === 'ftbend') return;
    var k = (s.hour || 0) + ':' + (s.minute || 0);
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > max) max = counts[k];
  });
  return max;
}

// How long the last member of the busiest cohort waits, in whole minutes,
// never below `floorMinutes`. The floors are the pre-2026-09-17 values so
// neither the health alert nor the missed-call detector ever gets LESS
// patient than it was under the 15-minute hash.
function staggerWindowMinutes(schedules, spacingSeconds, floorMinutes) {
  var n = maxCohortSize(schedules);
  var lastMs = n > 0 ? (n - 1) * spacingSeconds * 1000 : 0;
  var mins = Math.ceil(lastMs / 60000);
  return Math.max(floorMinutes || 0, mins);
}

module.exports = {
  DEFAULT_SPACING_SECONDS: DEFAULT_SPACING_SECONDS,
  spacingSecondsFrom: spacingSecondsFrom,
  cohortOrder: cohortOrder,
  cohortDelayMs: cohortDelayMs,
  maxCohortSize: maxCohortSize,
  staggerWindowMinutes: staggerWindowMinutes
};
