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
