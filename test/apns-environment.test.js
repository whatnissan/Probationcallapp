const test = require('node:test');
const assert = require('node:assert');
const { sendPushBothEnvironments, isEnvironmentMismatch } = require('../lib/apns');

// A fake APNs. Records every send so "was this sent twice?" is answerable.
function fakeApns(behaviour) {
  const sent = [];
  const sender = async (opts) => {
    sent.push(opts.environment);
    const r = behaviour[opts.environment];
    if (!r) throw new Error('unexpected environment ' + opts.environment);
    return r;
  };
  return { sender, sent };
}
const OK = { ok: true, status: 200, apnsId: 'APNS-1', reason: null, unregistered: false };
const WRONG_ENV = { ok: false, status: 400, reason: 'BadEnvironmentKeyInToken', unregistered: false };
const BAD_TOKEN = { ok: false, status: 400, reason: 'BadDeviceToken', unregistered: true };
const GONE = { ok: false, status: 410, reason: 'Unregistered', unregistered: true };
const TIMEOUT = { ok: false, status: 0, reason: 'Timeout', unregistered: false };

// THE BUG THIS EXISTS FOR: a TestFlight build claimed 'sandbox', so a
// production token was sent to the sandbox host and Apple refused it.
test('a production token stored as sandbox is still delivered, and the store is corrected', async function() {
  const { sender, sent } = fakeApns({ production: OK, sandbox: WRONG_ENV });
  const r = await sendPushBothEnvironments(sender, { token: 't', environment: 'sandbox' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.environmentUsed, 'production');
  assert.strictEqual(r.environmentFixed, true, 'caller must persist the correction');
  assert.deepStrictEqual(sent, ['production'], 'production is tried first, so no retry was even needed');
});

test('a genuine sandbox token still works — production first, then the retry finds it', async function() {
  const { sender, sent } = fakeApns({ production: WRONG_ENV, sandbox: OK });
  const r = await sendPushBothEnvironments(sender, { token: 't', environment: 'sandbox' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.environmentUsed, 'sandbox');
  assert.strictEqual(r.environmentFixed, false, 'the stored value was already right — nothing to write');
  assert.deepStrictEqual(sent, ['production', 'sandbox']);
});

// The safety property: a retry must never be able to deliver twice.
test('a successful send is NEVER followed by a second send', async function() {
  for (const stored of ['production', 'sandbox']) {
    const { sender, sent } = fakeApns({ production: OK, sandbox: OK });
    const r = await sendPushBothEnvironments(sender, { token: 't', environment: stored });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sent.length, 1, 'exactly one send on success (stored=' + stored + ')');
  }
});

test('only environment-shaped failures retry — nothing else guesses', async function() {
  assert.strictEqual(isEnvironmentMismatch(WRONG_ENV), true);
  assert.strictEqual(isEnvironmentMismatch(BAD_TOKEN), true);
  assert.strictEqual(isEnvironmentMismatch(GONE), false, '410 Unregistered is a dead token, not a wrong host');
  assert.strictEqual(isEnvironmentMismatch(TIMEOUT), false);
  assert.strictEqual(isEnvironmentMismatch(OK), false);

  // A timeout must not trigger a second send: it may have been delivered.
  const { sender, sent } = fakeApns({ production: TIMEOUT, sandbox: OK });
  const r = await sendPushBothEnvironments(sender, { token: 't', environment: 'production' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(sent, ['production'], 'a timeout is not retried on the other host');
});

// Pruning on the first BadDeviceToken is what would retire a live token that
// was only ever addressed to the wrong host.
test('a token is only called dead when BOTH environments refuse it', async function() {
  const a = await sendPushBothEnvironments(fakeApns({ production: BAD_TOKEN, sandbox: OK }).sender,
    { token: 't', environment: 'production' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.unregistered, false, 'it worked on the other host — it is not dead');

  const b = await sendPushBothEnvironments(fakeApns({ production: BAD_TOKEN, sandbox: BAD_TOKEN }).sender,
    { token: 't', environment: 'production' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.unregistered, true, 'both refused it — now it is prunable');
});

test('every attempt is reported, so a failure says what was actually tried', async function() {
  const r = await sendPushBothEnvironments(fakeApns({ production: WRONG_ENV, sandbox: BAD_TOKEN }).sender,
    { token: 't', environment: 'sandbox' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.attempts.map(a => a.environment), ['production', 'sandbox']);
  assert.deepStrictEqual(r.attempts.map(a => a.reason), ['BadEnvironmentKeyInToken', 'BadDeviceToken']);
});

test('preferStored honours the stored claim first, for callers that want it', async function() {
  const { sender, sent } = fakeApns({ sandbox: OK, production: OK });
  await sendPushBothEnvironments(sender, { token: 't', environment: 'sandbox', preferStored: true });
  assert.deepStrictEqual(sent, ['sandbox']);
});

// The gateway is the fact that settles any environment dispute, and it has
// to come from inside the sender — restating the environment we passed in
// would just be echoing the value under suspicion.
test('every attempt reports the gateway it actually dialled', async function() {
  const { HOSTS } = require('../lib/apns');
  const sender = async (opts) => ({
    ok: opts.environment === 'sandbox',
    status: opts.environment === 'sandbox' ? 200 : 400,
    reason: opts.environment === 'sandbox' ? null : 'BadDeviceToken',
    unregistered: opts.environment !== 'sandbox',
    host: HOSTS[opts.environment]
  });
  const r = await sendPushBothEnvironments(sender, { token: 't', environment: 'sandbox' });
  assert.deepStrictEqual(r.attempts.map(a => a.host), [
    'https://api.push.apple.com',
    'https://api.sandbox.push.apple.com'
  ]);
  assert.strictEqual(HOSTS.production, 'https://api.push.apple.com');
  assert.strictEqual(HOSTS.sandbox, 'https://api.sandbox.push.apple.com');
});
