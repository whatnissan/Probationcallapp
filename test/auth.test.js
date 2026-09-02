const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { resolveBearerUser, emailTombstoneHash } = require('../lib/auth');

// A syntactically perfect, unexpired, correctly-signed JWT. If v1 auth ever
// decoded locally, this token would pass. It must not: only the auth server
// knows the user was deleted five seconds ago.
function freshJwt() {
  return jwt.sign({ sub: '11111111-2222-3333-4444-555555555555', email: 'gone@example.com', aud: 'authenticated' },
    'not-the-real-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

test('v1 auth asks the auth server: a valid-looking unexpired JWT is REJECTED when the server says the user is gone', async function() {
  var askedWith = null;
  var client = { auth: { getUser: async function(token) { askedWith = token; return { data: { user: null }, error: { message: 'User not found' } }; } } };
  var r = await resolveBearerUser(client, 'Bearer ' + freshJwt());
  assert.strictEqual(r.user, null);
  assert.strictEqual(r.reason, 'rejected');
  assert.ok(askedWith && askedWith.split('.').length === 3, 'the raw token is handed to the auth server verbatim');
});

test('v1 auth accepts exactly what the auth server returns, nothing decoded from the token', async function() {
  var client = { auth: { getUser: async function() { return { data: { user: { id: 'server-says-this-id', email: 'server@example.com' } }, error: null }; } } };
  var r = await resolveBearerUser(client, 'Bearer ' + freshJwt());
  assert.strictEqual(r.user.id, 'server-says-this-id'); // not the JWT's sub
  assert.strictEqual(r.reason, null);
});

test('v1 auth: missing header is "missing", never a server call', async function() {
  var called = false;
  var client = { auth: { getUser: async function() { called = true; return {}; } } };
  var r = await resolveBearerUser(client, undefined);
  assert.strictEqual(r.reason, 'missing');
  assert.strictEqual(called, false);
});

test('tombstone hash normalises case and whitespace, and is not the email', function() {
  var h = emailTombstoneHash('  Someone@Example.COM ');
  assert.strictEqual(h, emailTombstoneHash('someone@example.com'));
  assert.strictEqual(h.length, 64);
  assert.ok(h.indexOf('@') < 0);
  assert.strictEqual(emailTombstoneHash(''), null);
});
