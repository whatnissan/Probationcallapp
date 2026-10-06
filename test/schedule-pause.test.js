const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pauseStateOnSave } = require('../lib/schedule-pause');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-09-30: every schedule save forced enabled: true, so a subscriber who
// paused in the app and then changed how they are notified was silently
// resumed and billed. A save now lifts a pause only when its cause is gone.

const paused = (reason) => ({ id: 's1', enabled: false, paused_reason: reason });
const RUNNING = { enabled: true, paused_reason: null };
const email = { notify_method: 'email', notify_email: 'a@example.invalid', notify_number: null };
const sms = { notify_method: 'sms', notify_email: null, notify_number: '+15555550100' };

test('a new schedule, or one already running, is enabled', () => {
  assert.deepStrictEqual(pauseStateOnSave(null, email, {}), RUNNING);
  assert.deepStrictEqual(pauseStateOnSave({ id: 's1', enabled: true, paused_reason: null }, email, {}), RUNNING);
});

test("the person's own pause survives any save", () => {
  assert.deepStrictEqual(pauseStateOnSave(paused('user'), email, {}), { enabled: false, paused_reason: 'user' });
  assert.deepStrictEqual(pauseStateOnSave(paused('user'), sms, { credits: 50, numberOptedOut: false }),
    { enabled: false, paused_reason: 'user' }, 'no fact about the account lifts it either');
});

test('no_credits stays paused at zero and lifts once there are credits', () => {
  assert.deepStrictEqual(pauseStateOnSave(paused('no_credits'), email, { credits: 0 }), { enabled: false, paused_reason: 'no_credits' });
  assert.deepStrictEqual(pauseStateOnSave(paused('no_credits'), email, {}), { enabled: false, paused_reason: 'no_credits' },
    'a failed credits read never resumes');
  assert.deepStrictEqual(pauseStateOnSave(paused('no_credits'), email, { credits: 3 }), RUNNING);
});

test('sms_opted_out lifts only when the saved channel can deliver', () => {
  const kept = { enabled: false, paused_reason: 'sms_opted_out' };
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'), sms, { numberOptedOut: true }), kept, 'still texting a stopped number');
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'), sms, {}), kept, 'an unknown opt-out state never resumes');
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'), sms, { numberOptedOut: false }), RUNNING, 'a number that can receive');
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'), email, {}), RUNNING, 'switched to email');
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'),
    { notify_method: 'both', notify_email: 'a@example.invalid', notify_number: '+15555550100' }, { numberOptedOut: true }),
    RUNNING, 'both, with the email side working');
  assert.deepStrictEqual(pauseStateOnSave(paused('sms_opted_out'), { notify_method: 'email', notify_email: null }, {}), kept,
    'email chosen with no address delivers nothing');
});

test('pin_expired lifts only when the save carries a different PIN (2026-10-06)', () => {
  const pe = (pin) => Object.assign(paused('pin_expired'), { pin: pin });
  assert.deepStrictEqual(pauseStateOnSave(pe('111111'), Object.assign({}, sms, { pin: '222222' }), {}), RUNNING, 'new PIN: resumed');
  const kept = { enabled: false, paused_reason: 'pin_expired' };
  assert.deepStrictEqual(pauseStateOnSave(pe('111111'), Object.assign({}, sms, { pin: '111111' }), {}), kept, 'same PIN: stays paused');
  assert.deepStrictEqual(pauseStateOnSave(pe('111111'), Object.assign({}, sms, { pin: ' 111111 ' }), {}), kept, 'same PIN with spaces');
  assert.deepStrictEqual(pauseStateOnSave(paused('pin_expired'), Object.assign({}, sms, { pin: '222222' }), {}), kept, 'stored PIN not read: never resumes');
  assert.deepStrictEqual(pauseStateOnSave(pe('111111'), Object.assign({}, sms, { pin: null }), {}), kept, 'no PIN sent');
});

test('the PIN-expired count resets only on a new schedule or a changed PIN', () => {
  const { pinChanged } = require('../lib/schedule-pause');
  assert.strictEqual(pinChanged({ pin: '111111' }, { pin: '222222' }), true);
  assert.strictEqual(pinChanged({ pin: '111111' }, { pin: '111111' }), false, 'an unrelated save keeps the count');
  assert.strictEqual(pinChanged({}, { pin: '222222' }), false, 'unknown stored PIN: no reset');
  assert.match(server, /if \(!existing \|\| pinChanged\(existing, data\)\) data\.consecutive_pin_expired = 0;/, 'applyPauseOnSave owns the reset');
  assert.ok(!/^\s*consecutive_pin_expired: 0\s*$/m.test(server), 'no writer resets it unconditionally any more');
});

test('other pauses a save fixes still resume: unknown_streak and legacy untagged', () => {
  assert.deepStrictEqual(pauseStateOnSave(paused('unknown_streak'), sms, {}), RUNNING);
  assert.deepStrictEqual(pauseStateOnSave(paused(null), sms, {}), RUNNING);
  assert.deepStrictEqual(pauseStateOnSave({ id: 's1', enabled: false }, sms, {}), RUNNING, 'column absent reads as untagged');
});

test('a reason this code does not know is kept, never undone', () => {
  assert.deepStrictEqual(pauseStateOnSave(paused('something_new'), email, { credits: 10, numberOptedOut: false }),
    { enabled: false, paused_reason: 'something_new' });
});

function slice(start, len) {
  const i = server.indexOf(start);
  assert.ok(i > 0, start + ' should be findable');
  return server.slice(i, i + len);
}

test('both writers read the pause and decide through the one helper', () => {
  const v1 = slice("app.put('/api/v1/schedule'", 16000);
  const web = slice("app.post('/api/schedule'", 12000);
  for (const [name, body] of [['v1 PUT', v1], ['website', web]]) {
    assert.match(body, /select\('id, enabled, paused_reason, pin'\)/, name + ' reads the current pause and PIN');
    assert.match(body, /await applyPauseOnSave\(req\.user\.id, /, name + ' applies the rule');
    assert.ok(!/^\s*enabled: true,/m.test(body), name + ' no longer forces enabled: true');
  }
  const v1Code = v1.replace(/\/\/.*$/gm, '');
  assert.ok(!/\bb\.enabled\b/.test(v1Code), 'enabled in a PUT body is not a resume — /schedule/resume is');
});

test('the website is told when a save left the checks paused', () => {
  assert.match(slice("app.post('/api/schedule'", 12000), /res\.json\(\{ success: true, enabled: data\.enabled, pausedReason: data\.paused_reason \}\)/);
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /d\.success && d\.enabled === false/, 'the form does not say "saved" as if running');
});

test('PUT /schedule/testing-office writes the office and nothing else', () => {
  const i = server.indexOf("app.put('/api/v1/schedule/testing-office', authV1");
  assert.ok(i > 0, 'the endpoint exists');
  const ep = server.slice(i, server.indexOf('\n});', i)).replace(/\/\/.*$/gm, '');
  assert.match(ep, /\.update\(\{ testing_office_id: office\.value \}\)/, 'one column');
  for (const call of ['rescheduleUser', 'applyPauseOnSave', 'startMontgomeryFirstDayCall', 'writeFtbendSignupDayVerdict', 'notify(', 'deductCreditOnce', 'consecutive_pin_expired', 'enabled']) {
    assert.ok(!ep.includes(call), 'never touches ' + call);
  }
  assert.match(ep, /resolveTestingOfficeId\(b\.testingOfficeId, sched\.data\.county\)/, 'same validation as PUT /schedule');
  assert.match(server, /var office = await resolveTestingOfficeId\(b\.testingOfficeId, county\);/, 'PUT /schedule uses the same validator');
});

test('the contract documents the PIN rules and §4.7a', () => {
  const contract = require('fs').readFileSync(require('path').join(__dirname, '..', 'API_CONTRACT.md'), 'utf8');
  assert.match(contract, /### 4\.7a `PUT \/schedule\/testing-office`/);
  assert.match(contract, /\| `pin_expired` \| Resumed \*\*only if the save carries a different PIN\*\*/);
  assert.match(contract, /a \*\*PIN change\*\*\nclears `consecutive_pin_expired`/);
});

test('POST /schedule/resume refuses pin_expired with 409, before the credits rule', () => {
  const i = server.indexOf("app.post('/api/v1/schedule/resume', authV1");
  const h = server.slice(i, server.indexOf('\n});', i));
  const refusal = h.indexOf("cur.data.paused_reason === 'pin_expired'");
  assert.ok(refusal > 0, 'resume checks for pin_expired');
  assert.match(h.slice(refusal, refusal + 400), /v1Error\(res, 409, 'pin_expired'/);
  assert.ok(refusal < h.indexOf("'insufficient_credits'"), 'checked before credits — credits would not help');
  assert.ok(refusal < h.indexOf('.update(resumeFields)'), 'and before anything is written');
  const contract = require('fs').readFileSync(require('path').join(__dirname, '..', 'API_CONTRACT.md'), 'utf8');
  assert.match(contract, /Resume must also \*\*reject with `409 pin_expired`\*\*/);
  assert.match(contract, /`pin_expired` \(§4\.8\),/, 'listed with the standard codes');
});
