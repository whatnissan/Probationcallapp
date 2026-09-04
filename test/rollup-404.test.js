const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const robots = fs.readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8');

// ---- robots.txt ----
test('robots.txt disallows everything behind a sign-in and allows the rest', function() {
  for (const p of ['/dashboard', '/admin', '/api/', '/webhook/', '/twiml/', '/recording/']) {
    assert.ok(robots.includes('Disallow: ' + p), 'robots.txt must disallow ' + p);
  }
  assert.ok(/^Allow: \/$/m.test(robots), 'the marketing pages stay crawlable');
  assert.ok(/^User-agent: \*/m.test(robots), 'there must be a wildcard group');
});

// ---- the 404 handler ----
// It is only correct if nothing is registered after it. A route added below
// this middleware is silently unreachable, which is a nasty way to lose an
// endpoint, so the position is asserted rather than trusted.
test('the 404 handler is the last thing registered', function() {
  const handler = server.indexOf("app.use(function(req, res) {\n  if (req.path.indexOf('/api/v1/') === 0)");
  assert.ok(handler > 0, '404 handler not found');
  const after = server.slice(handler + 10);
  assert.ok(!/\napp\.(get|post|put|delete|use)\(/.test(after),
    'a route is registered AFTER the 404 handler and can never be reached');
});

test('the 404 answers each caller in its own shape', function() {
  const h = server.slice(server.indexOf("// ========== 404 =========="));
  assert.ok(/v1Error\(res, 404, 'not_found'/.test(h), 'v1 gets the contract error object');
  assert.ok(/res\.status\(404\)\.json\(\{ error: 'Not found' \}\)/.test(h), '/api/ gets plain JSON');
  assert.ok(/res\.status\(404\)\.type\('html'\)/.test(h), 'a human gets a page');
  assert.ok(/noindex/.test(h), 'the 404 page must not be indexable');
});

// ---- the widened rollup ----
test('the rollup gets its buckets from the lib, never a raw header', function() {
  assert.ok(/require\('\.\/lib\/ua-bucket'\)/.test(server), 'server.js must use lib/ua-bucket');
  // The raw header may be READ (to hand to uaBucket) but must never be
  // concatenated into a key.
  assert.ok(!/\+ ' a=' \+ String\(req\.headers\['user-agent'\]\)/.test(server),
    'a raw User-Agent must never be concatenated into a rollup key');
  assert.ok(!/function uaBucket\(req\)/.test(server),
    'the inline copy of uaBucket should be gone — lib/ua-bucket.js is the one');
});

test('an authenticated API line names the user; an anonymous one names the agent', function() {
  const m = server.match(/function reqRollupKey\(req\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'reqRollupKey not found');
  const body = m[1];
  assert.ok(/uid \? ' u=' \+ uid/.test(body), 'a known user is still named the same way');
  assert.ok(/' u=- a=' \+ uaBucket\(req\.headers\['user-agent'\]\)/.test(body),
    "a request with no user must name the agent — 'u=-' alone identifies nobody");
});

test('the page rollup is switchable without a deploy and marked temporary', function() {
  assert.ok(/process\.env\.REQ_ROLLUP_PAGES !== 'false'/.test(server),
    'REQ_ROLLUP_PAGES must default on and be switchable off');
  assert.ok(/TEMPORARY \(2026-09-03\)/.test(server),
    'the block must say it is temporary and when it went in');
});

// The referral paths forked once and drifted for months: only one enforced
// the first-purchase window, only one was idempotent, and they disagreed on
// what a failed bonus grant does to the attribution. A referral decides who
// gets paid, so the two entry points must not be able to fork again.
test('both referral entry points go through the one shared applier', function() {
  const v1 = server.slice(server.indexOf("app.post('/api/v1/referral/apply'"));
  const v1Body = v1.slice(0, v1.indexOf('\n});'));
  const web = server.slice(server.indexOf("app.post('/api/apply-referral'"));
  const webBody = web.slice(0, web.indexOf('\n});'));

  for (const [name, body] of [['v1', v1Body], ['web', webBody]]) {
    assert.ok(/applyReferralForUser\(/.test(body), name + ' must call applyReferralForUser');
    // No handler may claim, grant, or decide on its own again.
    assert.ok(!/referred_by/.test(body), name + ' must not touch referred_by directly');
    assert.ok(!/recordCreditAdd\(/.test(body), name + ' must not grant the bonus itself');
    assert.ok(!/referralApplyDecision\(/.test(body), name + ' must not re-implement the decision');
    assert.ok(!/from\('purchases'\)/.test(body), name + ' must not re-implement the window check');
  }
});

test('the shared applier enforces the window and keeps attribution on grant failure', function() {
  const f = server.slice(server.indexOf('async function applyReferralForUser'));
  const body = f.slice(0, f.indexOf('\n}\n'));
  assert.ok(/from\('purchases'\)/.test(body), 'the first-purchase window lives here');
  assert.ok(/is\('referred_by', null\)/.test(body), 'the claim must stay atomic');
  assert.ok(/AFFILIATE_ENABLED/.test(body), 'the bonus is gated on the program being live');
  // Attribution must NOT be released when the grant fails — the old web
  // path did that, and it silently frees the slot for a different code.
  assert.ok(!/referred_by: null/.test(body), 'a failed grant must not release the attribution');
});
