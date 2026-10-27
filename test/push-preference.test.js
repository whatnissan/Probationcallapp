const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

// The Push choice, through the REAL server offline (test-support/
// push-pref-harness.js: fake Apple push service that records every push,
// fake Twilio, a Fort Bend morning driven end to end). Dave, 2026-10-28.
// Every scenario here behaved differently on the code before the change:
// Push off was ignored (pushed, text held), a second device got nothing,
// a stale-only device still held the text, and /me never returned push.

let observed;
function run() {
  if (observed) return observed;
  const port = String(41000 + Math.floor(Math.random() * 8000));
  const outText = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-support', 'push-pref-harness.js')], {
    env: Object.assign({}, process.env, { PORT: port, DISABLE_BACKGROUND_JOBS: '' }), timeout: 60000
  }).toString();
  observed = JSON.parse(outText.trim().split('\n').pop());
  assert.ok(!observed.error, observed.error);
  assert.strictEqual(observed.populate, 200);
  return observed;
}

test('Push off: no push at all, and the text goes now — no hold', () => {
  assert.deepStrictEqual(run().off, { pushes: 0, textsNow: 1, reason: 'push_off' });
});

test('two devices seen within 14 days: both are pushed, the text is held', () => {
  assert.deepStrictEqual(run().twoDevices, { pushes: 2, accepted: 2, textsNow: 0, held: true });
});

test('only a device unseen for 14+ days: one courtesy push, and the text now', () => {
  assert.deepStrictEqual(run().staleOnly, { pushes: 1, textsNow: 1, reason: 'stale_device', accepted: 1 });
});

test('no device: the text now, as before', () => {
  assert.deepStrictEqual(run().noDevice, { pushes: 0, textsNow: 1, reason: 'no_device' });
});

test('an acknowledgement cancels the held text; no acknowledgement, the text follows', () => {
  const o = run();
  assert.strictEqual(o.ackStatus, 200);
  assert.deepStrictEqual(o.afterHold, { ackedTexts: 0, unackedTexts: 1 });
});

test('GET /devices says which devices get results; GET /me returns push when it is on', () => {
  const o = run();
  assert.deepStrictEqual(o.devices.PR, ['tokPR1:true', 'tokPR2:true']);
  assert.deepStrictEqual(o.devices.PS, ['tokPS:true'], 'the courtesy push counts');
  assert.deepStrictEqual(o.devices.PO, ['tokPO:false'], 'Push off: no device receives results');
  assert.deepStrictEqual(o.meNotifyMethods, { PO: ['sms'], PR: ['push', 'sms'] });
});

test('THE BUILD GATE through PUT /schedule (PUSH_PREF_MIN_BUILD=25): build 24 omitting push never turns it off', () => {
  // Builds before 25 never saw a stored Push value — their Account sheet
  // always reopened it unticked — so their saves leave 'push' out by
  // accident. See test/push-targets.test.js for the full reasoning.
  const g = run().gate;
  assert.strictEqual(g.b24Status, 200, g.b24Err);
  assert.strictEqual(g.afterBuild24WithoutPush, true, 'build 24 saved without push: Push stays on');
  assert.strictEqual(g.b25Status, 200);
  assert.strictEqual(g.afterBuild25WithoutPush, false, 'build 25 saved without push: Push is off');
  assert.deepStrictEqual(g.build25ResponseMethods, ['email'], 'and the response says so');
  assert.strictEqual(g.afterBuild24WithPush, true, 'an older build can still turn it back on');
  assert.strictEqual(g.afterNoBuildWithoutPush, true, 'no build in the User-Agent: never off');
});
