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
test('the rollup never logs a raw user-agent', function() {
  const m = server.match(/function uaBucket\(req\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'uaBucket not found');
  const body = m[1];
  assert.ok(!/return ua;/.test(body), 'a raw UA must never become a bucket');
  assert.ok(/uaSlug\(ua\)/.test(body), 'open-ended buckets go through the slug');
  const slug = server.match(/function uaSlug\(ua\) \{([\s\S]*?)\n\}/);
  assert.ok(/slice\(0, 20\)/.test(slug[1]), 'the slug is length capped');
  assert.ok(/\[A-Za-z0-9_.-\]/.test(slug[1]), 'the slug is word characters only');
});

test('the API rollup line is unchanged — it is load bearing', function() {
  const m = server.match(/function reqRollupKey\(req\) \{([\s\S]*?)\n\}/);
  assert.ok(/u=' \+ uid/.test(m[1]), 'the API line still keys on the user id');
  assert.ok(/isApi\n?\s*\? reqRollupKey\(req\)/.test(server.replace(/\s+/g, ' ').replace(/ /g, ' ')) ||
    /isApi[\s\S]{0,40}reqRollupKey\(req\)/.test(server),
    'API requests must still use reqRollupKey');
});

test('the page rollup is switchable without a deploy and marked temporary', function() {
  assert.ok(/process\.env\.REQ_ROLLUP_PAGES !== 'false'/.test(server),
    'REQ_ROLLUP_PAGES must default on and be switchable off');
  assert.ok(/TEMPORARY \(2026-09-03\)/.test(server),
    'the block must say it is temporary and when it went in');
});
