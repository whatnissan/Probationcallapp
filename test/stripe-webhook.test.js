const test = require('node:test');
const assert = require('node:assert');
const Stripe = require('stripe');
const { constructEventWithSecrets } = require('../lib/stripe-webhook');
const stripe = Stripe('sk_test_placeholder');
const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'account.updated', data: { object: { id: 'acct_1' } } });

test('an event signed with the CONNECT secret verifies when the account secret is listed first', function() {
  var sig = stripe.webhooks.generateTestHeaderString({ payload: payload, secret: 'whsec_connect' });
  var ev = constructEventWithSecrets(stripe, payload, sig, ['whsec_account', 'whsec_connect']);
  assert.strictEqual(ev.type, 'account.updated');
});

test('unset secrets are skipped; a signature matching neither is rejected', function() {
  var sig = stripe.webhooks.generateTestHeaderString({ payload: payload, secret: 'whsec_other' });
  assert.throws(function() { constructEventWithSecrets(stripe, payload, sig, ['whsec_account', undefined, '']); });
  assert.throws(function() { constructEventWithSecrets(stripe, payload, sig, []); }, /no webhook signing secret/);
});

// Since 2026-09-03 each endpoint passes exactly ONE secret, so an event
// signed for the other endpoint must be rejected rather than accepted under
// the wrong destination's secret.
test('one secret per endpoint: the other endpoint\'s signature is rejected', function() {
  var connectSig = stripe.webhooks.generateTestHeaderString({ payload: payload, secret: 'whsec_connect' });
  assert.throws(function() { constructEventWithSecrets(stripe, payload, connectSig, ['whsec_account']); });
  var ev = constructEventWithSecrets(stripe, payload, connectSig, ['whsec_connect']);
  assert.strictEqual(ev.type, 'account.updated');
});

test('an unset endpoint secret rejects everything instead of accepting it', function() {
  var sig = stripe.webhooks.generateTestHeaderString({ payload: payload, secret: 'whsec_connect' });
  assert.throws(function() { constructEventWithSecrets(stripe, payload, sig, [undefined]); },
    /no webhook signing secret/);
});
