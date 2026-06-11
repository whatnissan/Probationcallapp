// Timezone-aware date helpers, extracted verbatim from server.js so they
// can be unit-tested (test/time.test.js).

// Format a UTC Date as YYYY-MM-DD in the given IANA timezone. Used for
// "is this row from today?" staleness checks across the date boundary.
function formatLocalDay(date, tz) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  var y = parts.find(function(p) { return p.type === 'year'; }).value;
  var m = parts.find(function(p) { return p.type === 'month'; }).value;
  var d = parts.find(function(p) { return p.type === 'day'; }).value;
  return y + '-' + m + '-' + d;
}

// Format today's date as M/D in the given TZ (no leading zeros). Used
// to date-stamp daily notification email subjects so Gmail doesn't bundle
// multiple days into one collapsed thread in the recipient's inbox.
function todayMD(tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Chicago',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date());
  var m = parts.find(function(p) { return p.type === 'month'; }).value;
  var d = parts.find(function(p) { return p.type === 'day'; }).value;
  return m + '/' + d;
}

// Would firing at `utcMoment` violate the "no attempt later than 2:00 PM
// local" cutoff? At minute precision: 14:00 OK, 14:01+ not OK.
function wouldExceedCutoff(utcMoment, tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric'
  }).formatToParts(utcMoment);
  var hour = parseInt(parts.find(function(p) { return p.type === 'hour'; }).value, 10);
  var minute = parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10);
  if (hour < 14) return false;
  if (hour > 14) return true;
  return minute > 0;
}

// Fort Bend cutoff: 9:30 AM CDT hard stop. Fort Bend hotlines close earlier
// than Montgomery (~10-11 AM); 9:30 leaves buffer for the cutoff path to
// notify users before lines close. At minute precision: 9:30 OK, 9:31+ NOT
// OK. Always called with America/Chicago — Fort Bend is single-county/TZ.
function wouldExceedFtbendCutoff(utcMoment, tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric'
  }).formatToParts(utcMoment);
  var hour = parseInt(parts.find(function(p) { return p.type === 'hour'; }).value, 10);
  var minute = parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10);
  if (hour < 9) return false;
  if (hour > 9) return true;
  return minute > 30;
}

module.exports = {
  formatLocalDay: formatLocalDay,
  todayMD: todayMD,
  wouldExceedCutoff: wouldExceedCutoff,
  wouldExceedFtbendCutoff: wouldExceedFtbendCutoff
};
