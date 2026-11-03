const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

// Boots the real server against a fake Supabase (test-support/funnel-harness.js)
// and checks the endpoints themselves: what is stored, what is refused, and
// that the admin summary counts it. Runs once — the server is started and
// stopped inside the harness.
let out;
try {
  out = JSON.parse(execFileSync(process.execPath,
    [path.join(__dirname, '..', 'test-support', 'funnel-harness.js')],
    { encoding: 'utf8', timeout: 60000 }).trim().split('\n').pop());
} catch (e) {
  throw new Error('harness failed: ' + e.message);
}

test('the harness ran to the end', function() {
  assert.ok(!out.error, out.error);
});

test('an app event is stored against the signed-in account', function() {
  assert.strictEqual(out.asked.status, 201);
  assert.strictEqual(out.asked.recorded, true);
  assert.strictEqual(out.asked.rows, 1);
  assert.ok(out.asked.userId, 'the row carries the account');
});

test('props are whitelisted on the way in', function() {
  assert.strictEqual(out.answered.status, 201);
  assert.deepStrictEqual(out.answered.props, { answer: 'yes' });
});

test('an unknown name is accepted and not stored', function() {
  assert.strictEqual(out.unknown.status, 201);
  assert.strictEqual(out.unknown.recorded, false);
  assert.strictEqual(out.unknown.rows, 0);
});

test('a server-only name cannot be forged by the app', function() {
  assert.strictEqual(out.serverOnly.recorded, false);
});

test('the app endpoint needs a bearer', function() {
  assert.strictEqual(out.noAuth, 401);
});

test('the page beacon is unauthenticated, stores src, and drops a hostile one', function() {
  assert.strictEqual(out.open.status, 204);
  assert.strictEqual(out.open.row.src, 'ios-onboarding');
  assert.strictEqual(out.open.row.user_id, null, 'no account is known on the page');
  assert.strictEqual(out.openBad, null);
});

test('a redemption records success with its credits and the src', function() {
  assert.strictEqual(out.redeem.status, 200);
  assert.strictEqual(out.redeem.success.name, 'redeem_success');
  assert.strictEqual(out.redeem.success.src, 'ios-onboarding');
  assert.deepStrictEqual(out.redeem.success.props, { credits: '5' });
});

test('a refusal records its v1 error code', function() {
  assert.strictEqual(out.bad.status, 404);
  assert.deepStrictEqual(out.bad.failed.props, { reason: 'promo_not_found' });
});

test('the admin summary counts names, sources, reasons and rates', function() {
  assert.strictEqual(out.summary.status, 200);
  assert.strictEqual(out.summary.totals.onboarding_partner_asked, 1);
  assert.strictEqual(out.summary.totals.redeem_page_open, 2);
  assert.strictEqual(out.summary.srcs['ios-onboarding'], 3);
  assert.strictEqual(out.summary.failures.promo_not_found, 1);
  assert.strictEqual(out.summary.rates.answered, 100);
  assert.strictEqual(out.summary.rates.redeemed, 50, 'one success of two opens');
  assert.strictEqual(out.summary.days[0].onboarding_partner_asked, 1);
});

test('the summary is admin-only', function() {
  assert.strictEqual(out.summaryNoAuth, 401);
});
