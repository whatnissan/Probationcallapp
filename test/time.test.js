const test = require('node:test');
const assert = require('node:assert');

const { formatLocalDay, todayMD, wouldExceedCutoff, wouldExceedFtbendCutoff } = require('../lib/time');

const CHI = 'America/Chicago';

test('formatLocalDay: converts UTC instants to the local calendar day', function() {
  // 2026-06-12 03:00 UTC = 2026-06-11 22:00 CDT — still the 11th in Chicago
  assert.strictEqual(formatLocalDay(new Date('2026-06-12T03:00:00Z'), CHI), '2026-06-11');
  // Midday is unambiguous
  assert.strictEqual(formatLocalDay(new Date('2026-06-11T17:00:00Z'), CHI), '2026-06-11');
  // Winter (CST, UTC-6): 2026-01-10 05:30 UTC = 2026-01-09 23:30 CST
  assert.strictEqual(formatLocalDay(new Date('2026-01-10T05:30:00Z'), CHI), '2026-01-09');
});

test('wouldExceedCutoff: 14:00 local is OK, 14:01 is not (CDT, UTC-5)', function() {
  assert.strictEqual(wouldExceedCutoff(new Date('2026-06-11T18:59:00Z'), CHI), false); // 13:59
  assert.strictEqual(wouldExceedCutoff(new Date('2026-06-11T19:00:00Z'), CHI), false); // 14:00 exactly
  assert.strictEqual(wouldExceedCutoff(new Date('2026-06-11T19:01:00Z'), CHI), true);  // 14:01
  assert.strictEqual(wouldExceedCutoff(new Date('2026-06-11T21:00:00Z'), CHI), true);  // 16:00
  assert.strictEqual(wouldExceedCutoff(new Date('2026-06-11T11:00:00Z'), CHI), false); // 06:00
});

test('wouldExceedFtbendCutoff: 9:30 local is OK, 9:31 is not (CDT)', function() {
  assert.strictEqual(wouldExceedFtbendCutoff(new Date('2026-06-11T14:29:00Z'), CHI), false); // 09:29
  assert.strictEqual(wouldExceedFtbendCutoff(new Date('2026-06-11T14:30:00Z'), CHI), false); // 09:30 exactly
  assert.strictEqual(wouldExceedFtbendCutoff(new Date('2026-06-11T14:31:00Z'), CHI), true);  // 09:31
  assert.strictEqual(wouldExceedFtbendCutoff(new Date('2026-06-11T16:00:00Z'), CHI), true);  // 11:00
  assert.strictEqual(wouldExceedFtbendCutoff(new Date('2026-06-11T10:05:00Z'), CHI), false); // 05:05 cron time
});

test('todayMD: M/D shape with no leading zeros', function() {
  assert.match(todayMD(CHI), /^\d{1,2}\/\d{1,2}$/);
  assert.match(todayMD(), /^\d{1,2}\/\d{1,2}$/); // default TZ path
});

// --- H1: Fort Bend retry backoff ---
const { ftbendRetryDelayMs, FTBEND_RETRY_BACKOFF_MINUTES } = require('../lib/time');

test('ftbendRetryDelayMs: 5 / 10 / 20 / 30 by attempt, then holds at 30', function() {
  assert.strictEqual(ftbendRetryDelayMs(1), 5 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(2), 10 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(3), 20 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(4), 30 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(9), 30 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(38), 30 * 60 * 1000); // the observed runaway
});

test('ftbendRetryDelayMs: junk input falls back to the first interval', function() {
  assert.strictEqual(ftbendRetryDelayMs(0), 5 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(-3), 5 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(null), 5 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs(undefined), 5 * 60 * 1000);
  assert.strictEqual(ftbendRetryDelayMs('abc'), 5 * 60 * 1000);
});

test('backoff bounds a morning to ~10 attempts, not ~52', function() {
  // 05:05 -> 09:30 cutoff is 265 minutes.
  var elapsed = 0, attempts = 0;
  while (elapsed < 265 && attempts < 100) {
    attempts++;
    elapsed += ftbendRetryDelayMs(attempts) / 60000;
  }
  assert.ok(attempts <= 12, 'expected <=12 attempts in the window, got ' + attempts);
  assert.ok(attempts >= 8, 'expected >=8 attempts (still responsive), got ' + attempts);
  // The old flat-5-minute schedule would have allowed 53.
  assert.strictEqual(Math.ceil(265 / 5), 53);
});

// ---- endOfLocalDayEpochSeconds (§4.12a NO_TEST push expiry) ----
const { endOfLocalDayEpochSeconds } = require('../lib/time');

test('endOfLocalDayEpochSeconds: midnight Central, expressed in UTC', function() {
  // 2026-09-14 ends at 2026-09-15 00:00 CDT = 05:00 UTC
  assert.strictEqual(endOfLocalDayEpochSeconds('2026-09-14', CHI), Date.parse('2026-09-15T05:00:00Z') / 1000);
  // Winter: CST is UTC-6
  assert.strictEqual(endOfLocalDayEpochSeconds('2026-01-20', CHI), Date.parse('2026-01-21T06:00:00Z') / 1000);
});

test('endOfLocalDayEpochSeconds: DST transition days still end at local midnight', function() {
  // 2026-03-08 is spring-forward (23-hour day); 2026-11-01 is fall-back (25-hour day).
  assert.strictEqual(endOfLocalDayEpochSeconds('2026-03-08', CHI), Date.parse('2026-03-09T05:00:00Z') / 1000);
  assert.strictEqual(endOfLocalDayEpochSeconds('2026-11-01', CHI), Date.parse('2026-11-02T06:00:00Z') / 1000);
  // The instant returned is the FIRST second that is no longer that day.
  var t = endOfLocalDayEpochSeconds('2026-11-01', CHI);
  assert.strictEqual(formatLocalDay(new Date((t - 1) * 1000), CHI), '2026-11-01');
  assert.strictEqual(formatLocalDay(new Date(t * 1000), CHI), '2026-11-02');
});

test('endOfLocalDayEpochSeconds: junk input is null, never a made-up expiry', function() {
  assert.strictEqual(endOfLocalDayEpochSeconds('yesterday', CHI), null);
  assert.strictEqual(endOfLocalDayEpochSeconds(null, CHI), null);
  assert.strictEqual(endOfLocalDayEpochSeconds('2026-13-40', CHI), null);
});
