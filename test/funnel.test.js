const test = require('node:test');
const assert = require('node:assert');
const funnel = require('../lib/funnel');

test('every app event the iOS client can send is on the wire', function() {
  // FunnelEvent.swift's raw values. A name added there without being added
  // here is dropped in silence, which is the failure worth pinning.
  ['onboarding_partner_asked', 'onboarding_partner_answered', 'onboarding_partner_left',
   'onboarding_partner_returned', 'onboarding_partner_applied',
   'onboarding_partner_not_applied', 'onboarding_partner_abandoned'].forEach(function(n) {
    assert.ok(funnel.isAppEvent(n), n + ' is an app event');
    assert.ok(funnel.known(n), n + ' is known');
  });
});

test('server-only events are known but refused from the app', function() {
  ['redeem_page_open', 'redeem_success', 'redeem_failed'].forEach(function(n) {
    assert.ok(funnel.known(n));
    assert.ok(!funnel.isAppEvent(n), n + ' must not be app-sendable');
  });
});

test('an unknown name is dropped', function() {
  assert.strictEqual(funnel.known('onboarding_partner_whatever'), false);
  assert.strictEqual(funnel.known('__proto__'), false);
  assert.deepStrictEqual(funnel.props('onboarding_partner_whatever', { a: 1 }), {});
});

test('only declared props survive, stringified', function() {
  assert.deepStrictEqual(
    funnel.props('onboarding_partner_answered', { answer: 'yes', junk: 'x', credits: 9 }),
    { answer: 'yes' });
  assert.deepStrictEqual(funnel.props('onboarding_partner_left', { junk: 'x' }), {});
  assert.deepStrictEqual(
    funnel.props('onboarding_partner_applied', { credits: 5 }),
    { credits: '5' });
});

test('empty and null props are dropped rather than stored as "null"', function() {
  assert.deepStrictEqual(funnel.props('onboarding_partner_not_applied', { phase: '' }), {});
  assert.deepStrictEqual(funnel.props('onboarding_partner_not_applied', { phase: null }), {});
  assert.deepStrictEqual(funnel.props('onboarding_partner_left', null), {});
  assert.deepStrictEqual(funnel.props('onboarding_partner_left', 'yes'), {});
});

test('props are cut at the cap', function() {
  var long = 'a'.repeat(200);
  assert.strictEqual(funnel.props('onboarding_partner_not_applied', { phase: long }).phase.length,
                     funnel.PROP_MAX);
});

test('only known src values are stored', function() {
  assert.strictEqual(funnel.source('ios-onboarding'), 'ios-onboarding');
  assert.strictEqual(funnel.source('ios-account'), 'ios-account');
  assert.strictEqual(funnel.source('ios-buy'), 'ios-buy');
  assert.strictEqual(funnel.source('IOS-ONBOARDING'), null);
  assert.strictEqual(funnel.source('ios-onboarding" onload="x'), null);
  assert.strictEqual(funnel.source(undefined), null);
  assert.strictEqual(funnel.source(null), null);
  assert.strictEqual(funnel.source({}), null);
});
