const test = require('node:test');
const assert = require('node:assert');
const cr = require('../lib/connect-refresh');
const SECRET = 'a'.repeat(48);
const UID = '111c6d60-0000-4000-8000-000000000000';
const NOW = Date.parse('2026-09-03T12:00:00Z');

test('a fresh token round-trips to the same user id', function() {
  const t = cr.mintToken(UID, SECRET, NOW);
  assert.strictEqual(cr.readToken(t, SECRET, NOW), UID);
  assert.strictEqual(cr.readToken(t, SECRET, NOW + 29 * 60 * 1000), UID);
});

test('the token does not reveal the account id', function() {
  // It goes to Stripe, into browser history, and possibly a Referer header.
  const t = cr.mintToken(UID, SECRET, NOW);
  assert.ok(!t.includes(UID));
  assert.ok(!t.includes(UID.slice(0, 8)));
  const decoded = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  assert.ok(!decoded.includes(UID.slice(0, 8)), 'plaintext id recoverable from the token');
});

test('it expires', function() {
  const t = cr.mintToken(UID, SECRET, NOW);
  assert.strictEqual(cr.readToken(t, SECRET, NOW + cr.TTL_MS + 1), null);
});

test('tampering, wrong key and junk all fail closed', function() {
  const t = cr.mintToken(UID, SECRET, NOW);
  assert.strictEqual(cr.readToken(t, 'b'.repeat(48), NOW), null);          // wrong secret
  // Always a DIFFERENT character: writing a fixed 'A' over a random token
  // left it unchanged about 1 run in 64 (first char already 'A'), and the
  // suite failed at random. The last base64url char can hold padding bits,
  // so the body flip is in the middle, where every bit is real.
  const other = function(c) { return c === 'A' ? 'B' : 'A'; };
  const mid = Math.floor(t.length / 2);
  assert.strictEqual(cr.readToken(t.slice(0, mid) + other(t[mid]) + t.slice(mid + 1), SECRET, NOW), null); // flipped tag/ciphertext
  assert.strictEqual(cr.readToken(other(t[0]) + t.slice(1), SECRET, NOW), null);   // flipped iv
  ['', null, undefined, 'not-a-token', '....', 'a'.repeat(200)].forEach(function(bad) {
    assert.strictEqual(cr.readToken(bad, SECRET, NOW), null, 'accepted: ' + bad);
  });
});

test('no secret means no token and no verification', function() {
  assert.strictEqual(cr.mintToken(UID, null, NOW), null);
  assert.strictEqual(cr.readToken('anything', null, NOW), null);
  assert.strictEqual(cr.mintToken(null, SECRET, NOW), null);
});

test('two mints of the same id differ (random iv, not a stable identifier)', function() {
  // A stable token would itself become a tracker for that account.
  assert.notStrictEqual(cr.mintToken(UID, SECRET, NOW), cr.mintToken(UID, SECRET, NOW));
});

test('a token is URL-safe', function() {
  const t = cr.mintToken(UID, SECRET, NOW);
  assert.strictEqual(t, encodeURIComponent(t));
});
