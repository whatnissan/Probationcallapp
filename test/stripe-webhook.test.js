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
