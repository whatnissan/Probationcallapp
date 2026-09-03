const test = require('node:test');
const assert = require('node:assert');
const a = require('../lib/affiliate');
const NOW = Date.parse('2026-09-02T21:00:00Z');
const D = 86400000;
function row(status, cents, ageDays, extra) { return Object.assign({ status: status, amount_cents: cents, created_at: new Date(NOW - ageDays * D).toISOString(), available_at: new Date(NOW - ageDays * D + a.HOLD_DAYS * D).toISOString() }, extra || {}); }

test('a commission is held for 30 days, then reads as available without a column flip', function() {
  assert.strictEqual(a.effectiveStatus(row('held', 449, 10), NOW), 'held');
  assert.strictEqual(a.effectiveStatus(row('held', 449, 31), NOW), 'available');
  assert.strictEqual(a.effectiveStatus(row('held', 449, 30), NOW), 'available');
  assert.strictEqual(a.availableAt(NOW), new Date(NOW + 30 * D).toISOString());
});

test('balances: held, available, paid, reversed, lifetime — reversed never counts toward lifetime', function() {
  var rows = [row('held', 449, 5), row('held', 449, 40), row('paid', 900, 90, { stripe_transfer_id: 'tr_1' }), row('reversed', 449, 60), row('transferred', 300, 120, { stripe_transfer_id: 'tr_0' })];
  var b = a.summarizeBalances(rows, NOW);
  assert.deepStrictEqual(b, { heldCents: 449, availableCents: 449, paidCents: 1200, reversedCents: 449, lifetimeCents: 2098 });
});

test('payout plan: only available rows, only when payouts are enabled, only at or above $20', function() {
  var rows = [row('held', 1500, 40), row('held', 600, 35), row('held', 449, 3)];
  var p = a.payoutPlan(rows, NOW, true, 2000);
  assert.strictEqual(p.pay, true); assert.strictEqual(p.amountCents, 2100); assert.strictEqual(p.rows.length, 2);
  assert.strictEqual(a.payoutPlan(rows, NOW, false, 2000).reason, 'payouts_not_enabled');
  assert.strictEqual(a.payoutPlan([row('held', 1500, 40)], NOW, true, 2000).reason, 'below_minimum');
});

test('clawback: ledger-only during the hold, transfer reversal only after payout, noop when terminal', function() {
  assert.strictEqual(a.clawbackAction(row('held', 449, 3)), 'ledger');
  assert.strictEqual(a.clawbackAction(row('available', 449, 40)), 'ledger');
  assert.strictEqual(a.clawbackAction(row('paid', 449, 60, { stripe_transfer_id: 'tr_1' })), 'reverse_transfer');
  assert.strictEqual(a.clawbackAction(row('reversed', 449, 60)), 'noop');
  assert.strictEqual(a.clawbackAction(row('reversal_failed', 449, 60)), 'noop');
});

test('pre-screen: skips without a Stripe call, and never authorizes one', function() {
  var now = Date.parse('2026-09-03T12:00:00Z');
  var big = [{ amount_cents: 5000, status: 'available' }];
  var fresh = new Date(now - 86400000).toISOString();
  var stale = new Date(now - 30 * 86400000).toISOString();

  // No Connect account, and under the $20 minimum: skipped before Stripe.
  assert.strictEqual(a.payoutPreScreen({}, big, now, 2000).reason, 'no_connect_account');
  assert.strictEqual(a.payoutPreScreen({ stripe_connect_id: 'acct_1' },
    [{ amount_cents: 300, status: 'available' }], now, 2000).reason, 'below_minimum');

  // A recently-synced "not payouts enabled" is trusted to skip.
  assert.strictEqual(a.payoutPreScreen({
    stripe_connect_id: 'acct_1', stripe_connect_payouts_enabled: false,
    stripe_connect_updated_at: fresh
  }, big, now, 2000).reason, 'payouts_not_enabled_cached');

  // UNKNOWN IS NOT FALSE. Never synced, or synced too long ago, falls
  // through to the live gate rather than silently costing a month.
  assert.strictEqual(a.payoutPreScreen({ stripe_connect_id: 'acct_1' }, big, now, 2000).attempt, true);
  assert.strictEqual(a.payoutPreScreen({
    stripe_connect_id: 'acct_1', stripe_connect_payouts_enabled: false,
    stripe_connect_updated_at: stale
  }, big, now, 2000).attempt, true);

  // A cached "payouts enabled: true" still only means "attempt" — the live
  // payoutPlan gate is what authorizes, and it can still refuse.
  var pass = a.payoutPreScreen({
    stripe_connect_id: 'acct_1', stripe_connect_payouts_enabled: true,
    stripe_connect_updated_at: fresh
  }, big, now, 2000);
  assert.strictEqual(pass.attempt, true);
  assert.strictEqual(a.payoutPlan(pass.rows, now, false, 2000).pay, false);
});

test('pre-screen counts a held row past its date, like the live plan does', function() {
  var now = Date.parse('2026-09-03T12:00:00Z');
  var rows = [{ amount_cents: 5000, status: 'held', available_at: '2026-08-01T00:00:00Z' }];
  var screen = a.payoutPreScreen({ stripe_connect_id: 'acct_1' }, rows, now, 2000);
  assert.strictEqual(screen.attempt, true);
  assert.strictEqual(screen.amountCents, 5000);
  // Still held, not yet due: below the minimum because it does not count.
  var notYet = [{ amount_cents: 5000, status: 'held', available_at: '2026-10-01T00:00:00Z' }];
  assert.strictEqual(a.payoutPreScreen({ stripe_connect_id: 'acct_1' }, notYet, now, 2000).reason, 'below_minimum');
});

test('connect state from the cached profile columns', function() {
  assert.strictEqual(a.connectState({}), 'not_started');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1' }), 'in_progress');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true }), 'pending_review');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true, stripe_connect_payouts_enabled: true }), 'ready');
});

test('connect state: requirements tell "Stripe is reviewing" from "you owe a document"', function() {
  var submitted = { stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true };
  // Submitted, nothing outstanding -> Stripe is reviewing.
  assert.strictEqual(a.connectState(Object.assign({}, submitted, {
    stripe_connect_requirements_currently_due: [], stripe_connect_requirements_past_due: []
  })), 'pending_review');
  // Submitted, but Stripe came back asking for something -> the affiliate's move.
  assert.strictEqual(a.connectState(Object.assign({}, submitted, {
    stripe_connect_requirements_currently_due: ['individual.id_number']
  })), 'in_progress');
  assert.strictEqual(a.connectState(Object.assign({}, submitted, {
    stripe_connect_requirements_past_due: ['external_account']
  })), 'in_progress');
  // payouts_enabled still wins over anything outstanding.
  assert.strictEqual(a.connectState(Object.assign({}, submitted, {
    stripe_connect_payouts_enabled: true, stripe_connect_requirements_currently_due: ['x']
  })), 'ready');
});

test('connect state: NULL requirements are UNKNOWN, not "nothing due"', function() {
  // Never synced (pre-048 row): keep the old, less precise answer rather
  // than claiming the affiliate has nothing left to do.
  assert.strictEqual(a.connectState({
    stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true,
    stripe_connect_requirements_currently_due: null, stripe_connect_requirements_past_due: null
  }), 'pending_review');
  assert.strictEqual(a.requirementsOutstanding({}), false);
  assert.strictEqual(a.requirementsOutstanding(null), false);
});

test('referral apply: idempotency outranks the purchase gate', function() {
  var d = a.referralApplyDecision;
  // The ordering that matters: same code already applied, and the account has
  // since bought something. This is a RETRY of a call that already worked, so
  // it must not be refused as too late.
  assert.strictEqual(d('DAVE30', 'DAVE30', true), 'idempotent');
  assert.strictEqual(d('DAVE30', 'DAVE30', false), 'idempotent');
});

test('referral apply: the other three outcomes', function() {
  var d = a.referralApplyDecision;
  assert.strictEqual(d('DAVE30', 'OTHER99', false), 'conflict');      // 409 referral_already_applied
  assert.strictEqual(d('DAVE30', 'OTHER99', true), 'conflict');       // a code wins over the gate either way
  assert.strictEqual(d(null, 'DAVE30', true), 'after_purchase');      // 409 referral_after_purchase
  assert.strictEqual(d(null, 'DAVE30', false), 'apply');              // the only path that claims
});

test('next payout date is the first of next month, Central time', function() {
  assert.strictEqual(a.nextPayoutDate(Date.parse('2026-09-02T21:00:00Z')), '2026-10-01');
  assert.strictEqual(a.nextPayoutDate(Date.parse('2026-12-31T23:00:00Z')), '2027-01-01'); // still Dec 31 in Chicago
});
