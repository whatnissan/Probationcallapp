const test = require('node:test');
const assert = require('node:assert');
const { ledgerMismatches, sharedPhoneFlag, parseSettingValue } = require('../lib/integrity');

test('ledger mismatch: balance must equal the sum of ledger rows, deductions included', function() {
  var profiles = [{ id: 'a', credits: 5 }, { id: 'b', credits: 1 }, { id: 'c', credits: 0 }];
  var ledger = [{ user_id: 'a', amount: 5 }, { user_id: 'b', amount: 5 }, { user_id: 'b', amount: -1 }, { user_id: 'b', amount: -1 }, { user_id: 'b', amount: -1 }, { user_id: 'b', amount: -1 }];
  var m = ledgerMismatches(profiles, ledger);
  assert.deepStrictEqual(m, [{ userId: 'c', credits: 0, ledgerSum: 0, gap: 0 }].filter(function() { return false; }).concat([]));
  // b: 5 - 4 = 1 matches; a matches; c has no rows and 0 credits — matches.
  assert.strictEqual(m.length, 0);
  var m2 = ledgerMismatches([{ id: 'd', credits: 65 }], [{ user_id: 'd', amount: 60 }]);
  assert.deepStrictEqual(m2, [{ userId: 'd', credits: 65, ledgerSum: 60, gap: 5 }]);
});

test('shared phone: flags only when OTHER accounts hold the number, de-duplicated, never refuses', function() {
  assert.strictEqual(sharedPhoneFlag('me', '+15551234567', [{ user_id: 'me' }]), null);
  assert.strictEqual(sharedPhoneFlag('me', '+15551234567', []), null);
  assert.strictEqual(sharedPhoneFlag('me', '', [{ user_id: 'x' }]), null);
  var f = sharedPhoneFlag('me', '+15551234567', [{ user_id: 'x' }, { user_id: 'x' }, { user_id: 'y' }, { user_id: 'me' }]);
  assert.strictEqual(f.reason, 'shared_phone');
  assert.deepStrictEqual(f.details.otherUserIds, ['x', 'y']);
  assert.strictEqual(f.details.phoneLast4, '4567');
  assert.ok(!('phone' in f.details), 'the full number is not stored on the flag');
});

test('settings values are JSON scalars', function() {
  assert.strictEqual(parseSettingValue('5', 0), 5);
  assert.strictEqual(parseSettingValue(5, 0), 5);
  assert.strictEqual(parseSettingValue('false', true), false);
  assert.strictEqual(parseSettingValue(true, false), true);
  assert.strictEqual(parseSettingValue(null, 7), 7);
  assert.strictEqual(parseSettingValue(undefined, 7), 7);
});
