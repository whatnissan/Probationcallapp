const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// The ws-ticket limiter exists to stop a request loop from reaching Supabase.
// Placed AFTER auth() it would still pay supabase.auth.getUser() plus a
// profile read for every request it rejects — i.e. it would 429 the loop and
// change nothing about the load that actually hurt. The ordering IS the fix,
// so it is asserted rather than left to a future reviewer's eye.
test('the ws-ticket rate limit runs before auth, not after', function() {
  // The whole route line: the middleware chain now contains parentheses of
  // its own, so it cannot be matched with a "not a paren" run.
  const m = server.match(/^app\.post\('\/api\/ws-ticket',(.*)$/m);
  assert.ok(m, 'POST /api/ws-ticket route not found');
  const chain = m[1];
  const rl = chain.indexOf('rateLimit');
  const au = chain.indexOf('auth');
  assert.ok(rl >= 0, 'ws-ticket has no rate limit');
  assert.ok(au >= 0, 'ws-ticket is no longer auth-protected');
  assert.ok(rl < au, 'rateLimit must come BEFORE auth in the ws-ticket chain');
});

test('the ws-ticket limit is keyed pre-auth, on the bearer token', function() {
  assert.ok(/rateLimit\('ws_ticket', 10, 60 \* 1000, bearerRateKey\)/.test(server),
    'ws_ticket must use bearerRateKey — req.user does not exist before auth()');
  // req.ip is the Railway proxy for every caller (no trust-proxy set), so a
  // pre-auth limiter keyed on it is one bucket shared by the whole world.
  const fn = server.match(/function bearerRateKey\(req\)\{?([\s\S]*?)\n\}/);
  assert.ok(fn, 'bearerRateKey not found');
  assert.ok(!/req\.ip/.test(fn[1]), 'bearerRateKey must not fall back to req.ip');
  assert.ok(/createHash/.test(fn[1]), 'the token must be hashed, never used raw as a key');
  assert.ok(/return null/.test(fn[1]), 'no token must opt out — auth() 401s it for free');
});

// A keyFn returning null means "not limited". If that ever starts meaning
// "limited under the key null" every tokenless request shares one bucket.
test('rateLimit treats a null key as no limit, not as a shared bucket', function() {
  const m = server.match(/function rateLimit\(bucket, max, windowMs, keyFn\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'rateLimit signature has changed');
  assert.ok(/if \(id === null \|\| id === undefined\) return next\(\);/.test(m[1]),
    'a null key must skip the limiter');
});

// Same bug, same treatment as auth(): adminAuth ran select('*') and wrote
// last_login on every admin request.
test('adminAuth reads named columns and throttles its last_login write', function() {
  const m = server.match(/async function adminAuth\(req, res, next\) \{([\s\S]*?)\n\}\n/);
  assert.ok(m, 'adminAuth not found');
  // Comments stripped first: the comment that explains the change quotes
  // select('*'), and an assertion that a comment can satisfy is not one.
  const body = m[1].split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/select\('\*'\)/.test(body), "adminAuth must not select('*')");
  assert.ok(/select\(AUTH_PROFILE_COLUMNS\)/.test(body),
    'adminAuth must select the same named set as auth()');
  assert.ok(/lastLoginThrottle\.take\(/.test(body),
    'adminAuth must throttle last_login the way auth() does');
  const take = body.indexOf('lastLoginThrottle.take(');
  const write = body.indexOf('last_login: new Date()');
  assert.ok(take >= 0 && take < write, 'the write must be inside the throttle, not beside it');
});
