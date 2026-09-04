const test = require('node:test');
const assert = require('node:assert');
const { mint, verify } = require('../lib/ws-ticket');

const SECRET = 'a-test-secret-at-least-long-enough';
const USER = '11111111-2222-3333-4444-555555555555';

test('a freshly minted ticket verifies and returns the user it was bound to', function() {
  const t = mint(SECRET, USER, Date.now() + 60000);
  const r = verify(SECRET, t);
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(r.userId, USER);
});

// The distinction the reason codes exist for. Expired = our client is slow
// or looping. Forged = someone is making tickets up. Conflating them is
// what made tonight's client take hours to find.
test('expired and forged are different answers, never each other', function() {
  const expired = mint(SECRET, USER, Date.now() - 1);
  assert.strictEqual(verify(SECRET, expired).reason, 'expired');

  // Validly signed but expired must report expired, NOT bad_signature —
  // expiry is checked first precisely so this cannot be misreported.
  const wasValid = mint(SECRET, USER, 1000);
  assert.strictEqual(verify(SECRET, wasValid).reason, 'expired');

  const future = Date.now() + 60000;
  assert.strictEqual(verify(SECRET, USER + '.' + future + '.' + 'f'.repeat(64)).reason, 'bad_signature');
  // Right shape, wrong secret.
  assert.strictEqual(verify(SECRET, mint('a-different-secret-entirely', USER, future)).reason, 'bad_signature');
});

test('a ticket is bound to its user and its expiry — neither can be edited', function() {
  const future = Date.now() + 60000;
  const t = mint(SECRET, USER, future);
  const sig = t.split('.')[2];
  // Swap the user id, keep the signature: must not authenticate as someone else.
  const other = '99999999-8888-7777-6666-555555555555';
  assert.strictEqual(verify(SECRET, other + '.' + future + '.' + sig).reason, 'bad_signature');
  // Extend the expiry, keep the signature: must not buy more time.
  assert.strictEqual(verify(SECRET, USER + '.' + (future + 3600000) + '.' + sig).reason, 'bad_signature');
});

test('malformed input is refused without throwing', function() {
  for (const bad of ['', 'x', 'a.b', 'a.b.c.d', '...', 'a.notanumber.c']) {
    const r = verify(SECRET, bad);
    assert.strictEqual(r.userId, null, JSON.stringify(bad));
    assert.ok(['no_ticket', 'malformed'].includes(r.reason), bad + ' -> ' + r.reason);
  }
  // A wrong-length signature must not throw — timingSafeEqual does, on a
  // length mismatch, which is why the length is checked first.
  assert.strictEqual(verify(SECRET, USER + '.' + (Date.now() + 60000) + '.ab').reason, 'bad_signature');
});

// Without a secret the server cannot verify anything, and must refuse
// rather than fall open.
test('no secret refuses everything and mints nothing', function() {
  assert.strictEqual(mint('', USER, Date.now() + 60000), null);
  assert.strictEqual(mint(undefined, USER, Date.now() + 60000), null);
  assert.strictEqual(verify('', mint(SECRET, USER, Date.now() + 60000)).reason, 'no_secret');
  assert.strictEqual(verify(undefined, 'anything').userId, null);
});

test('expiry is evaluated against the clock it is given', function() {
  const t = mint(SECRET, USER, 10000);
  assert.strictEqual(verify(SECRET, t, 9999).reason, 'ok');
  assert.strictEqual(verify(SECRET, t, 10001).reason, 'expired');
});
