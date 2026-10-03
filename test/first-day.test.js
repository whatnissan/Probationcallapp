const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { firstDayDecision, recoveryDecision } = require('../lib/recovery');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-02 (Dave): a Montgomery schedule created inside 06:00–13:55
// Central, at or after its own call time, is dialled once that day,
// immediately — an explicit first-day path, never a recovery side effect.
// Times are UTC instants; comments give Central (CDT).

const S = (hour, minute, extra) => Object.assign({ county: 'montgomery', enabled: true, hour, minute }, extra || {});
const at = (iso, s) => firstDayDecision(new Date(iso), s, 'America/Chicago');

test('created after its call time inside the window: dialled once now', () => {
  assert.deepStrictEqual(at('2026-10-02T14:00:00Z', S(6, 30)), { dial: true, reason: 'first_day' }, '9:00 AM, 6:30 call time');
  assert.deepStrictEqual(at('2026-10-02T18:55:00Z', S(6, 0)), { dial: true, reason: 'first_day' }, '1:55 PM is still inside');
  assert.deepStrictEqual(at('2026-10-02T11:30:30Z', S(6, 30)), { dial: true, reason: 'first_day' }, 'during the call minute — the cron already fired');
});

test('nothing when the regular call or tomorrow\'s covers it', () => {
  assert.deepStrictEqual(at('2026-10-02T13:00:00Z', S(9, 0)), { dial: false, reason: 'regular_call_today' }, '8 AM signup, 9:00 call time');
  assert.deepStrictEqual(at('2026-10-02T10:30:00Z', S(6, 30)), { dial: false, reason: 'regular_call_today' }, '5:30 AM signup');
  assert.deepStrictEqual(at('2026-10-02T18:56:00Z', S(6, 30)), { dial: false, reason: 'after_window' }, '1:56 PM');
  assert.deepStrictEqual(at('2026-10-02T19:30:00Z', S(6, 30)), { dial: false, reason: 'after_window' }, '2:30 PM');
  assert.deepStrictEqual(at('2026-10-03T02:00:00Z', S(6, 30)), { dial: false, reason: 'after_window' }, '9 PM');
  assert.deepStrictEqual(at('2026-10-02T14:00:00Z', S(6, 30, { county: 'ftbend' })), { dial: false, reason: 'not_montgomery' });
  assert.deepStrictEqual(at('2026-10-02T14:00:00Z', S(6, 30, { enabled: false })), { dial: false, reason: 'paused' });
});

test('recovery never dials the same schedule: it skips anything created after its call time', () => {
  const created = '2026-10-02T14:00:00Z';                 // 9:00 AM, first-day call placed
  const s = S(6, 30, { created_at: created });
  assert.strictEqual(at(created, s).dial, true);
  assert.deepStrictEqual(recoveryDecision(new Date('2026-10-02T14:45:00Z'), s, { tz: 'America/Chicago', missedWindowMinutes: 20 }),
    { dial: false, reason: 'created_after_call_time' }, 'the 9:45 recovery run leaves it alone');
});

test('the first-day path: once, as the day\'s real call, never blocking the save', () => {
  const i = server.indexOf('async function startMontgomeryFirstDayCall(');
  const fn = server.slice(i, server.indexOf('\n}\n', i)).replace(/\/\/.*$/gm, '');
  assert.match(fn, /recovery\.firstDayDecision\(now, sched, 'America\/Chicago'\)/);
  assert.match(fn, /prof\.data\.is_demo \|\| prof\.data\.is_disabled/, 'never the demo account or a disabled one');
  assert.match(fn, /\(prof\.data\.credits \|\| 0\) < 1/, 'not without credits');
  for (const t of ['call_history', 'call_attempts', 'pending_retries']) {
    assert.match(fn, new RegExp("from\\('" + t + "'\\)\\.select\\('id'\\)\\.eq\\('user_id', userId\\)"), 'refuses if ' + t + ' shows anything today');
  }
  assert.match(fn, /initiateCall\([^;]*'montgomery', true, \{ origin: 'first_day' \}\)/, 'a real scheduled-morning call, billed and delivered normally');
  assert.match(fn, /staggerSpacingSeconds\(\) \* 1000/, 'spaced behind a recent dial');
  assert.match(fn, /'first_day_failed'/, 'a rejected dial tells the person');
  assert.match(server, /if \(config\.origin\) row\.origin = config\.origin;/, 'the result row carries origin');
  // Both writers, first creation only, not awaited.
  assert.match(server, /if \(!existing\.data\) startMontgomeryFirstDayCall\(req\.user\.id, data\)\.catch/);
  assert.match(server, /if \(!existingResult\.data\) startMontgomeryFirstDayCall\(req\.user\.id, data\)\.catch/);
  assert.ok(!/await startMontgomeryFirstDayCall/.test(server), 'never awaited by a save');
});
