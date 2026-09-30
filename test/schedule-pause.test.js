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

test('pauses a save fixes still resume: new PIN, and legacy untagged pauses', () => {
  assert.deepStrictEqual(pauseStateOnSave(paused('pin_expired'), sms, {}), RUNNING);
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
    assert.match(body, /select\('id, enabled, paused_reason'\)/, name + ' reads the current pause');
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
