const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { recoveryDecision, insideHotlineWindow } = require('../lib/recovery');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-02: the hourly missed-call recovery dialled a 9 PM signup with a
// 6:30 call time at 9:45 PM — outside the hotline window — and billed it.
// Times below are UTC instants; the comments give Central time.

const OLD = '2026-09-01T12:00:00Z';                      // created long ago
const sched = (hour, minute, createdAt) => ({ user_id: 'u', hour, minute, created_at: createdAt === undefined ? OLD : createdAt });
const at = (iso, s, w) => recoveryDecision(new Date(iso), s, { tz: 'America/Chicago', missedWindowMinutes: w || 20 });

test('the 9 PM signup from the report is not dialled at 9:45 PM', () => {
  const signup = sched(6, 30, '2026-10-03T02:00:00Z');     // 9:00 PM CDT Oct 2
  assert.deepStrictEqual(at('2026-10-03T02:45:00Z', signup), { dial: false, reason: 'after_window' }, '9:45 PM CDT');
});

test('nothing is dialled outside 06:00–14:00 Central, for anyone', () => {
  for (const iso of ['2026-10-02T10:45:00Z' /* 5:45 AM */, '2026-10-02T19:45:00Z' /* 2:45 PM */, '2026-10-02T23:45:00Z' /* 6:45 PM */, '2026-10-03T04:45:00Z' /* 11:45 PM */]) {
    assert.strictEqual(at(iso, sched(6, 30)).dial, false, iso);
  }
  assert.strictEqual(insideHotlineWindow(new Date('2026-10-02T11:00:00Z')), true, '6:00 AM CDT');
  assert.strictEqual(insideHotlineWindow(new Date('2026-10-02T19:00:00Z')), true, '2:00 PM CDT');
  assert.strictEqual(insideHotlineWindow(new Date('2026-10-02T19:01:00Z')), false, '2:01 PM CDT');
  assert.strictEqual(insideHotlineWindow(new Date('2026-10-02T10:59:00Z')), false, '5:59 AM CDT');
  assert.strictEqual(insideHotlineWindow(new Date('2026-12-02T12:00:00Z')), true, '6:00 AM CST');
  assert.strictEqual(insideHotlineWindow(new Date('2026-12-02T20:01:00Z')), false, '2:01 PM CST');
});

test('a genuinely missed morning call is still recovered inside the window', () => {
  assert.deepStrictEqual(at('2026-10-02T12:45:00Z', sched(6, 30)), { dial: true, reason: 'missed' }, '7:45 AM CDT, 6:30 schedule');
  assert.deepStrictEqual(at('2026-10-02T18:45:00Z', sched(13, 0)), { dial: true, reason: 'missed' }, '1:45 PM CDT, 1:00 PM schedule');
  assert.deepStrictEqual(at('2026-10-02T11:45:00Z', sched(6, 30)), { dial: false, reason: 'not_due' }, '6:45 AM — within the stagger window');
});

test('a schedule created at or after its own call time today is not recovered today', () => {
  assert.deepStrictEqual(at('2026-10-02T13:45:00Z', sched(6, 30, '2026-10-02T12:10:00Z')), { dial: false, reason: 'created_after_call_time' }, 'created 7:10 AM, call time 6:30');
  assert.deepStrictEqual(at('2026-10-02T13:45:00Z', sched(6, 30, '2026-10-02T11:30:20Z')), { dial: false, reason: 'created_after_call_time' }, 'created during the 6:30 minute — the cron already fired');
  assert.deepStrictEqual(at('2026-10-02T13:45:00Z', sched(6, 30, '2026-10-02T10:00:00Z')), { dial: true, reason: 'missed' }, 'created 5:00 AM, before its 6:30 call — a real miss');
  assert.deepStrictEqual(at('2026-10-03T12:45:00Z', sched(6, 30, '2026-10-03T02:00:00Z')), { dial: true, reason: 'missed' }, 'last night\'s 9 PM signup, NEXT morning: a real miss');
});

test('a schedule with no created_at keeps the window rule', () => {
  assert.deepStrictEqual(at('2026-10-02T12:45:00Z', sched(6, 30, null)), { dial: true, reason: 'missed' });
  assert.strictEqual(at('2026-10-03T02:45:00Z', sched(6, 30, null)).dial, false);
});

test('the hourly job uses these rules before it reads anything', () => {
  const i = server.indexOf('// ========== MISSED CALL RECOVERY ==========');
  const job = server.slice(i, server.indexOf("}, { timezone: 'America/Chicago' });", i));
  const guard = job.indexOf("if (!recovery.insideHotlineWindow(now, 'America/Chicago'))");
  assert.ok(guard > 0, 'window guard present');
  assert.ok(guard < job.indexOf(".from('user_schedules')"), 'and it returns before any database read');
  assert.match(job, /recovery\.recoveryDecision\(now, sched, \{ tz: 'America\/Chicago', missedWindowMinutes: missedWindow \}\)/);
  assert.ok(job.indexOf('recoveryDecision') < job.indexOf('initiateCall('), 'decided before any dial');
});
