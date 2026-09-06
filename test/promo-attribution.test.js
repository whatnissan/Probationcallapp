const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const a = require('../lib/affiliate');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---- payoutPreScreen: an open flag HOLDS the money ----
const READY = {
  stripe_connect_id: 'acct_1',
  stripe_connect_payouts_enabled: true,
  stripe_connect_updated_at: new Date().toISOString()
};
const BIG = [{ status: 'available', amount_cents: 5000, available_at: new Date(Date.now() - 1000).toISOString() }];

test('an unresolved review flag holds the payout, and says so', function() {
  const held = a.payoutPreScreen(READY, BIG, Date.now(), 2000, 1);
  assert.strictEqual(held.attempt, false);
  assert.strictEqual(held.reason, 'review_flagged');
  assert.strictEqual(held.openFlags, 1);
  // It HOLDS, it does not cancel — the eligible rows survive for next month.
  assert.ok(held.amountCents > 0 && held.rows.length > 0, 'earnings are untouched');
});

test('no flags pays exactly as before, and an absent count is backward compatible', function() {
  assert.strictEqual(a.payoutPreScreen(READY, BIG, Date.now(), 2000, 0).attempt, true);
  // Callers written before 2026-09-05 pass nothing; undefined must not hold.
  assert.strictEqual(a.payoutPreScreen(READY, BIG, Date.now(), 2000).attempt, true);
});

test('the flag check runs LAST — cheaper refusals still answer first', function() {
  // A flagged affiliate under the minimum is told 'below_minimum', not
  // 'review_flagged': the flag is not the reason they are unpaid.
  const small = [{ status: 'available', amount_cents: 100, available_at: new Date(Date.now() - 1000).toISOString() }];
  assert.strictEqual(a.payoutPreScreen(READY, small, Date.now(), 2000, 3).reason, 'below_minimum');
  assert.strictEqual(a.payoutPreScreen({}, BIG, Date.now(), 2000, 3).reason, 'no_connect_account');
});

// ---- the redeem endpoint's contract-shaped guarantees ----
function body(sig) {
  const i = server.indexOf(sig);
  assert.ok(i > 0, 'not found: ' + sig);
  return server.slice(i, server.indexOf('\n});', i));
}

test('redemption returns 200 even when attribution is refused', function() {
  const h = body("app.post('/api/v1/redeem'");
  // Scope to the ATTRIBUTION block only — from where it is first assigned to
  // where it is logged. The outer catch legitimately uses v1Error for an
  // unexpected throw, and a looser regex trips on that.
  const start = h.indexOf('var attribution =');
  const end = h.indexOf("console.log('[PROMO]");
  assert.ok(start > 0 && end > start, 'attribution block not found');
  const attributionBlock = h.slice(start, end);
  assert.ok(!/v1Error/.test(attributionBlock),
    'no attribution outcome may produce an error response — the credits already landed');
  assert.ok(/res\.json\(\{ credits: promo\.credits, attribution: attribution \}\)/.test(h));
  // And the grant must happen BEFORE attribution is attempted, so a refusal
  // can never strand someone without the credits they were promised.
  assert.ok(h.indexOf('recordCreditAdd') < start, 'credits are granted before attribution is tried');
});

test('redeem calls the shared applier — the rules never live in the route', function() {
  const h = body("app.post('/api/v1/redeem'");
  assert.ok(/applyReferralForUser\(/.test(h), 'must go through the shared applier');
  // No rule may be re-implemented here.
  assert.ok(!/referred_by/.test(h), 'must not claim attribution itself');
  assert.ok(!/from\('purchases'\)/.test(h), 'must not re-implement the window');
  assert.ok(!/referralApplyDecision/.test(h), 'must not re-implement the decision');
});

test('expiry and exhaustion are distinct on BOTH endpoints', function() {
  const v1 = body("app.post('/api/v1/redeem'");
  assert.ok(/promo_expired/.test(v1) && /promo_exhausted/.test(v1));
  assert.ok(/expires_at && Date\.parse/.test(v1), 'v1 must actually read expires_at');
  const web = body("app.post('/api/redeem'");
  assert.ok(/expires_at && Date\.parse/.test(web), 'the web path must read expires_at too');
  // The old bug: "Code expired" fired for exhausted uses.
  assert.ok(!/times_used >= promo\.max_uses\) return res\.status\(400\)\.json\(\{ error: 'Code expired'/.test(web));
});

test('idempotent attribution is reported as attributed, not as a failure', function() {
  const h = body("app.post('/api/v1/redeem'");
  assert.ok(/outcome === 'applied' \|\| r\.outcome === 'idempotent'/.test(h),
    'an idempotent retry means the commission is already intact');
  assert.ok(/alreadyAttributed: !!r\.alreadyAttributed/.test(h));
});

test('every refusal reason has office-facing wording', function() {
  const i = server.indexOf('var PROMO_ATTRIBUTION_MESSAGES');
  const block = server.slice(i, server.indexOf('\n};', i));
  for (const reason of ['after_purchase', 'conflict', 'self_referral', 'daily_cap', 'invalid_code', 'internal']) {
    assert.ok(new RegExp(reason + ':').test(block), 'no message for ' + reason);
  }
  // Every message must lead with the credits landing — that is the fact the
  // person at the counter cares about.
  const msgs = block.match(/'Credits added\.[^']*'/g) || [];
  assert.ok(msgs.length >= 6, 'each refusal says the credits landed: ' + msgs.length);
});

// ---- admin promo creation: validated, and failures are reported ----
test('promo creation validates every field it accepts', function() {
  const h = body("app.post('/api/admin/promo'");
  assert.ok(/\^\[A-Z0-9\]\{4,24\}\$/.test(h), 'code shape is validated');
  assert.ok(/credits < 1 \|\| credits > 1000/.test(h), 'credits are bounded');
  assert.ok(/maxUses < 1/.test(h), 'max uses is bounded');
  assert.ok(/t <= Date\.now\(\)/.test(h), 'a past expiry is refused at creation');
  assert.ok(/referral_code/.test(h), 'an affiliate without a referral code is refused');
});

// The bug this replaced: the insert result was ignored, so a duplicate code
// returned success having created nothing.
test('a duplicate code is reported, not swallowed', function() {
  const h = body("app.post('/api/admin/promo'");
  assert.ok(/ins\.error/.test(h), 'the insert result must be checked');
  assert.ok(/23505|duplicate key/.test(h), 'a unique violation is distinguished');
  assert.ok(/status\(409\)/.test(h), 'and reported as a conflict');
});

test('creation degrades honestly before migration 050', function() {
  const h = body("app.post('/api/admin/promo'");
  assert.ok(/affiliate_id.*test\(ins\.error\.message|\/affiliate_id\/\.test/.test(h),
    'a missing affiliate_id column is explained, not surfaced as a schema error');
  assert.ok(/migration 050/.test(h));
});
