const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { localDayBoundsUtc, formatLocalDay } = require('../lib/time');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-02: "today's row" was found with created_at between <day>T00:00:00
// and <day>T23:59:59 — the UTC day, five or six hours off Texas — so a row
// written after 7 PM CDT read as the next day's answer.

const TZ = 'America/Chicago';
test('a day is local midnight to local midnight, DST included', () => {
  assert.deepStrictEqual(localDayBoundsUtc('2026-10-02', TZ), { start: '2026-10-02T05:00:00.000Z', end: '2026-10-03T05:00:00.000Z' }, 'CDT');
  assert.deepStrictEqual(localDayBoundsUtc('2026-12-02', TZ), { start: '2026-12-02T06:00:00.000Z', end: '2026-12-03T06:00:00.000Z' }, 'CST');
  const fall = localDayBoundsUtc('2026-11-01', TZ);
  assert.strictEqual((Date.parse(fall.end) - Date.parse(fall.start)) / 3600000, 25, 'fall back: 25 hours');
  const spring = localDayBoundsUtc('2026-03-08', TZ);
  assert.strictEqual((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000, 23, 'spring forward: 23 hours');
  assert.strictEqual(localDayBoundsUtc('not-a-date', TZ), null);
});

test('an evening row belongs to its own Texas day, not the next one', () => {
  const b = localDayBoundsUtc('2026-10-02', TZ);
  const at = (iso) => iso >= b.start && iso < b.end;
  assert.strictEqual(at('2026-10-03T01:30:00.000Z'), true, '8:30 PM CDT Oct 2 is Oct 2');
  assert.strictEqual(at('2026-10-02T04:30:00.000Z'), false, '11:30 PM CDT Oct 1 is not Oct 2');
  assert.strictEqual(formatLocalDay(new Date('2026-10-03T01:30:00Z'), TZ), '2026-10-02');
});

test('every "today\'s row" reader uses the county\'s day', () => {
  const fn = (marker, len) => server.slice(server.indexOf(marker), server.indexOf(marker) + len);
  assert.match(fn("app.get('/api/v1/today'", 3000), /var todayBounds = localDayBoundsUtc\(today, tz\);/);
  assert.match(fn('async function deliverFtbendNotification(', 900), /var todayBounds = localDayBoundsUtc\(todayDate, 'America\/Chicago'\);/);
  assert.match(fn('async function writeFtbendSignupDayVerdict(', 1500), /var todayBounds = localDayBoundsUtc\(todayDate, 'America\/Chicago'\);/);
  assert.match(server, /function day\(ts\) \{ return formatLocalDay\(new Date\(ts\), 'America\/Chicago'\); \}/, 'reliability buckets by the Texas day');
});

// ---- commit 3: the rest of the inventory ----
const { daysBetweenLocalDays, shiftLocalDay, localWeekday } = require('../lib/time');

test('calendar helpers do date arithmetic, not clock arithmetic', () => {
  assert.strictEqual(daysBetweenLocalDays('2026-10-02', '2026-10-05'), 3);
  assert.strictEqual(daysBetweenLocalDays('2026-10-02', '2026-10-02'), 0, 'today is the last day: 0, not -1');
  assert.strictEqual(daysBetweenLocalDays('2026-10-02', '2026-08-21'), -42, 'ended six weeks ago stays negative');
  assert.strictEqual(daysBetweenLocalDays('2026-10-31', '2026-11-02'), 2, 'across the DST change');
  assert.strictEqual(daysBetweenLocalDays('2026-10-02', 'junk'), null);
  assert.strictEqual(shiftLocalDay('2026-10-02', -30), '2026-09-02');
  assert.strictEqual(localWeekday(new Date('2026-10-03T01:30:00Z'), TZ), 5, '8:30 PM CDT Fri Oct 2 is a Friday, not Saturday');
});

test('days remaining at 8 PM CDT counts from the Texas day', () => {
  // At 2026-10-03T01:00Z the server's UTC midnight is Oct 3; Texas is Oct 2.
  const texasToday = formatLocalDay(new Date('2026-10-03T01:00:00Z'), TZ);
  assert.strictEqual(daysBetweenLocalDays(texasToday, '2026-10-10'), 8, 'not 7');
});

test('no reader is left on the UTC day', () => {
  assert.ok(!/['"]T23:59:59['"]\)/.test(server), 'no UTC end-of-day bound');
  assert.ok(!/setHours\(0, 0, 0, 0\)/.test(server), 'no server-midnight "today"');
  assert.ok(!/created_at\.substring\(0, ?10\)/.test(server), 'no UTC date slice of created_at');
  assert.ok(!/new Date\((t|r)\.created_at\)\.get(Day|Date)\(\)/.test(server), 'no UTC weekday/day-of-month of a row');
  assert.ok(!/formatLocalDay\(new Date\(\), 'America\/Chicago'\) \+ 'T00:00:00'/.test(server), 'no Central date read as UTC midnight');
  const rec = server.slice(server.indexOf('// ========== MISSED CALL RECOVERY =========='));
  assert.match(rec.slice(0, 4000), /\.gte\('created_at', recoveryBounds\.start\)\s*\.lt\('created_at', recoveryBounds\.end\)/, 'recovery: called today on the Texas day');
});
