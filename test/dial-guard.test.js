const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { automaticDialDecision } = require('../lib/dial-guard');
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
  assert.match(ic.slice(guard, guard + 600), /from\('user_schedules'\)\.select\('enabled, paused_reason'\)\.eq\('user_id', userId\)\.maybeSingle\(\)/);
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
