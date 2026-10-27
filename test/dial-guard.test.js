const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { automaticDialDecision, liveDialParams, LIVE_COLUMNS } = require('../lib/dial-guard');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The dial-time pause check (2026-10-27). The rule, and where it is wired.

test('the decision: paused or missing never dials; a read failure does', () => {
  assert.deepStrictEqual(automaticDialDecision({ row: { enabled: true } }), { dial: true, reason: null, pausedReason: null });
  assert.deepStrictEqual(automaticDialDecision({ row: { enabled: false, paused_reason: 'user' } }), { dial: false, reason: 'paused', pausedReason: 'user' });
  assert.deepStrictEqual(automaticDialDecision({ row: { enabled: false, paused_reason: 'sms_opted_out' } }).dial, false);
  assert.deepStrictEqual(automaticDialDecision({ row: { enabled: false } }), { dial: false, reason: 'paused', pausedReason: null }, 'an untagged pause is still a pause');
  assert.deepStrictEqual(automaticDialDecision({ row: null }), { dial: false, reason: 'no_schedule', pausedReason: null });
  assert.deepStrictEqual(automaticDialDecision({ error: { message: 'down' } }), { dial: true, reason: 'read_failed', pausedReason: null },
    'a missed morning is the worse harm');
});

const fnBody = (name) => { const i = server.indexOf(name); assert.ok(i > 0, name); return server.slice(i, server.indexOf('\n}\n', i)); };

test('initiateCall checks the schedule row first, before anything is dialled', () => {
  const ic = fnBody('async function initiateCall(');
  const guard = ic.indexOf("if (userId && !(opts && opts.manual)) {");
  assert.ok(guard > 0, 'gated for every automatic dial');
  assert.ok(guard < ic.indexOf('twilioClient.calls.create('), 'before the dial');
  assert.ok(guard < ic.indexOf('pendingCalls.set('), 'before anything is recorded');
  assert.match(ic.slice(guard, guard + 600), /from\('user_schedules'\)\.select\(dialGuard\.LIVE_COLUMNS\)\.eq\('user_id', userId\)\.maybeSingle\(\)/);
});

// 2026-10-28, bug 3: queued retries dialled the PIN captured when they were
// queued. What is dialled now comes from the same dial-time read.
test('the live read carries everything a dial and its notice need', () => {
  for (const c of ['enabled', 'paused_reason', 'county', 'pin', 'target_number', 'notify_number', 'notify_email', 'notify_method']) {
    assert.ok(LIVE_COLUMNS.split(', ').includes(c), c);
  }
});

test('a schedule moved to Fort Bend is not dialled on the Montgomery line', () => {
  assert.deepStrictEqual(automaticDialDecision({ row: { enabled: true, county: 'ftbend' } }), { dial: false, reason: 'county_changed', pausedReason: null });
  assert.strictEqual(automaticDialDecision({ row: { enabled: true, county: 'montgomery' } }).dial, true);
  assert.strictEqual(automaticDialDecision({ row: { enabled: false, paused_reason: 'user', county: 'ftbend' } }).reason, 'paused', 'a pause is reported as a pause');
});

test('the schedule as it is now beats the copy queued with the dial', () => {
  const queued = { targetNumber: '+19362834848', pin: '111111', notifyNumber: '+15555550100', notifyEmail: 'old@example.invalid', notifyMethod: 'both' };
  const row = { pin: '222222', target_number: '+19362834848', notify_number: '+15555550199', notify_email: null, notify_method: 'sms' };
  assert.deepStrictEqual(liveDialParams(queued, row),
    { targetNumber: '+19362834848', pin: '222222', notifyNumber: '+15555550199', notifyEmail: null, notifyMethod: 'sms' },
    'new PIN dialled; a cleared email stays cleared');
  assert.deepStrictEqual(liveDialParams(queued, null), queued, 'a failed read dials what was queued');
  assert.strictEqual(liveDialParams(queued, Object.assign({}, row, { pin: '' })).pin, '111111', 'no PIN on the row: cannot dial without one');
  assert.strictEqual(liveDialParams(queued, Object.assign({}, row, { pin: ' 333333 ' })).pin, '333333');
});

test('initiateCall dials with the live values, and checks the demo PIN on them too', () => {
  const ic = fnBody('async function initiateCall(');
  const live = ic.indexOf('var live = dialGuard.liveDialParams(');
  assert.ok(live > 0);
  assert.match(ic, /liveSched\.error \? null : liveSched\.data\);/, 'a failed read falls back to the queued values');
  assert.ok(live < ic.indexOf("if (String(live.pin) === demoAccount.DEMO_PIN)"), 'tripwire on the live PIN');
  for (const v of ['targetNumber = live.targetNumber;', 'pin = live.pin;', 'notifyNumber = live.notifyNumber;', 'notifyEmail = live.notifyEmail;', 'notifyMethod = live.notifyMethod;']) {
    const at = ic.indexOf(v);
    assert.ok(at > live && at < ic.indexOf('pendingCalls.set('), v + ' before the call is recorded');
  }
});

test('a retry that gives up at cutoff tells the person where the schedule says now', () => {
  const cut = server.slice(server.indexOf('if (wouldExceedCutoff(new Date(), tz)) {'), server.indexOf('if (wouldExceedCutoff(new Date(), tz)) {') + 1400);
  assert.match(cut, /var cutoffLive = dialGuard\.liveDialParams\(/);
  assert.match(cut, /notify_number: cutoffLive\.notifyNumber,\s*notify_email: cutoffLive\.notifyEmail,\s*notify_method: cutoffLive\.notifyMethod,/);
  assert.match(server, /var retrySched = await supabase\.from\('user_schedules'\)\.select\(dialGuard\.LIVE_COLUMNS\)/);
});

test('only Call Now and the admin trigger are manual', () => {
  const manual = server.match(/\{ manual: true \}/g) || [];
  assert.strictEqual(manual.length, 2);
  assert.match(server, /initiateCall\(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, req\.user\.id, 0, county, undefined, \{ manual: true \}\)/, 'Call Now');
  const admin = server.slice(server.indexOf("app.post('/api/admin/trigger-call/:userId'"), server.indexOf("app.post('/api/admin/trigger-call/:userId'") + 2500);
  assert.match(admin, /sched\.county,\s*undefined,\s*\{ manual: true \}/, 'admin trigger');
});

test('the morning job re-reads the schedule when it fires', () => {
  const rs = fnBody('function rescheduleUser(');
  assert.match(rs, /var liveRead = await supabase\.from\('user_schedules'\)\.select\('\*'\)\.eq\('user_id', userId\)\.maybeSingle\(\);/);
  assert.match(rs, /sched = liveRead\.data \|\| sched;/, 'and dials with the schedule as it is now');
  assert.ok(rs.indexOf('var liveRead') < rs.indexOf('await initiateCall('));
});

test('pause and STOP stop the job and clear retries; START rebuilds it; the retry queue checks too', () => {
  const pause = server.slice(server.indexOf("app.post('/api/v1/schedule/pause'"), server.indexOf("app.post('/api/v1/schedule/resume'"));
  assert.match(pause, /await stopScheduledCalls\(req\.user\.id, '\[V1-PAUSE\]'\);/);
  assert.match(fnBody('async function applySmsOptOutToUser('), /await stopScheduledCalls\(userId, '\[SMS-OPTOUT\]'\);/);
  const stop = fnBody('async function stopScheduledCalls(');
  assert.match(stop, /scheduledJobs\.get\(userId\)\.stop\(\);/);
  assert.match(stop, /from\('pending_retries'\)\.delete\(\)\.eq\('user_id', userId\)/);
  assert.match(server, /if \(rbRow\.data\) rescheduleUser\(rbRow\.data\.user_id, rbRow\.data\);/, 'START rebuilds the job');
  assert.match(server, /var retryGate = dialGuard\.automaticDialDecision\(\{ error: retrySched\.error, row: retrySched\.data \}\);/);
  const poller = server.slice(server.indexOf('var retryGate'), server.indexOf('var retryGate') + 800);
  assert.match(poller, /from\('pending_retries'\)\.delete\(\)\.eq\('id', row\.id\);\s*continue;/);
  assert.ok(server.indexOf('var retryGate') < server.indexOf('if (wouldExceedCutoff(new Date(), tz)) {'), 'before the cutoff notice');
});
