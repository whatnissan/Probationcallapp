const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { recordingCheck } = require('../lib/ftbend');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-02: the 10:00 AM Fort Bend recording check. Rules are Dave's:
// every call-resolved office row has audio; no subscriber carries audio that
// is not its office row's; every subscriber has audio unless the office was
// resolved from finishprobation.com.

const REC = (c) => 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE' + c.repeat(32) + '.mp3';
const office = (o, extra) => Object.assign({ county: 'ftbend_' + o, resolved_by: 'call', recording_url: REC(o === 'missouri' ? 'a' : o === 'rosenberg' ? 'b' : 'c') }, extra || {});
const sub = (o, extra) => Object.assign({ user_id: o + '-user-0000', ftbend_office: o, result: 'COLOR:Gray', recording_url: office(o).recording_url }, extra || {});
const OFFICES = () => [office('missouri'), office('rosenberg'), office('rosenberg2')];

test('2026-10-02 as reported is clean', () => {
  const subs = [sub('missouri'), sub('missouri'), sub('rosenberg'), sub('rosenberg2'), sub('rosenberg2')];
  const out = recordingCheck(OFFICES(), subs);
  assert.deepStrictEqual(out.problems, []);
  assert.deepStrictEqual(out.summary, { offices: 3, callResolved: 3, subscriberRows: 5, wrongOffice: 0, missingAudio: 0 });
});

test('rule 1: a call-resolved office without its recording is reported; a missing office too', () => {
  const out = recordingCheck([office('missouri', { recording_url: null }), office('rosenberg')], []);
  assert.strictEqual(out.problems.length, 2);
  assert.match(out.problems[0], /missouri: resolved by our own call, but the office row has NO recording/);
  assert.match(out.problems[1], /rosenberg2: no office row today/);
});

test('rule 2: wrong-office audio is reported and counted', () => {
  const subs = [sub('rosenberg', { recording_url: office('missouri').recording_url })];
  const out = recordingCheck(OFFICES(), subs);
  assert.strictEqual(out.summary.wrongOffice, 1);
  assert.match(out.problems[0], /^WRONG OFFICE AUDIO: subscriber \S+ \(rosenberg\)/);
});

test('rule 3: a subscriber without audio is reported only when the office was resolved by our call', () => {
  const fp = [office('missouri', { resolved_by: 'finishprobation', recording_url: null }), office('rosenberg'), office('rosenberg2')];
  const subs = [sub('missouri', { recording_url: null }), sub('rosenberg', { recording_url: null })];
  const out = recordingCheck(fp, subs);
  assert.strictEqual(out.summary.missingAudio, 1, 'the Rosenberg one only');
  assert.match(out.problems[0], /^Missing audio: subscriber \S+ \(rosenberg\)/);
  assert.ok(!out.problems.some((p) => /missouri/.test(p)), 'a finishprobation-resolved office is expected to have no audio');
});

test('NO_CREDITS rows are exempt — no call was made for them', () => {
  const out = recordingCheck(OFFICES(), [sub('missouri', { result: 'NO_CREDITS', recording_url: null })]);
  assert.deepStrictEqual(out.problems, []);
  assert.strictEqual(out.summary.subscriberRows, 0);
});

test('rows from before 068 (no resolved_by): audio means our call; neither audio nor marker is reported', () => {
  assert.deepStrictEqual(recordingCheck([office('missouri', { resolved_by: null }), office('rosenberg'), office('rosenberg2')], [sub('missouri', { recording_url: null })]).summary.missingAudio, 1);
  const out = recordingCheck([office('missouri', { resolved_by: null, recording_url: null }), office('rosenberg'), office('rosenberg2')], []);
  assert.match(out.problems[0], /no record of how it was resolved/);
});

test('every office write declares how it was resolved', () => {
  const fn = server.slice(server.indexOf('async function storeFtbendColor('), server.indexOf('async function storeFtbendColor(') + 2600);
  assert.match(fn, /resolved_by: resolvedBy === 'call' \? 'call' : 'finishprobation'/);
});

test('the check runs at 10:00 Central and emails Dave, never silently', () => {
  assert.match(server, /cron\.schedule\('0 10 \* \* \*', async function\(\) \{\s*try \{\s*var out = await runFtbendRecordingCheck\(\);/);
  const alert = server.slice(server.indexOf('async function alertFtbendRecordingProblems('), server.indexOf('async function alertFtbendRecordingProblems(') + 1800);
  assert.match(alert, /var to = process\.env\.ALERT_EMAIL;/, 'to Dave via ALERT_EMAIL');
  assert.match(alert, /from\('profiles'\)\.select\('email'\)\.eq\('is_admin', true\)/, 'falls back to admins rather than dropping it');
  assert.match(server, /ftbend_recording_check: \{ subject: 'ALERT: Fort Bend recordings/);
  const ep = server.slice(server.indexOf("app.get('/api/admin/ftbend-recording-check', adminAuth"), server.indexOf("app.get('/api/admin/ftbend-recording-check', adminAuth") + 400);
  assert.ok(ep.length > 0 && !/alertFtbendRecordingProblems|sendEmail/.test(ep), 'the on-demand run never emails');
});
