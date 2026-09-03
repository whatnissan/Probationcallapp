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

test('connect state from the cached profile columns', function() {
  assert.strictEqual(a.connectState({}), 'not_started');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1' }), 'in_progress');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true }), 'pending_review');
  assert.strictEqual(a.connectState({ stripe_connect_id: 'acct_1', stripe_connect_details_submitted: true, stripe_connect_payouts_enabled: true }), 'ready');
});

test('next payout date is the first of next month, Central time', function() {
  assert.strictEqual(a.nextPayoutDate(Date.parse('2026-09-02T21:00:00Z')), '2026-10-01');
  assert.strictEqual(a.nextPayoutDate(Date.parse('2026-12-31T23:00:00Z')), '2027-01-01'); // still Dec 31 in Chicago
});
