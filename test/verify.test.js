const test = require('node:test');
const assert = require('node:assert');
const v = require('../lib/verify');
const NOW = Date.parse('2026-09-02T20:00:00Z');
const M = 60000;

test('codes are six digits, zero-padded, and the hmac binds user + phone + code', function() {
  for (var i = 0; i < 200; i++) assert.ok(/^\d{6}$/.test(v.generateCode()));
  var a = v.codeHmac('s', 'u1', '+15551234567', '123456');
  assert.notStrictEqual(a, v.codeHmac('s', 'u2', '+15551234567', '123456'));
  assert.notStrictEqual(a, v.codeHmac('s', 'u1', '+15557654321', '123456'));
  assert.notStrictEqual(a, v.codeHmac('other', 'u1', '+15551234567', '123456'));
  assert.ok(a.indexOf('123456') < 0);
});

test('resend is throttled to 60 seconds for the same user+phone', function() {
  var r = v.decideSend(NOW, { account: [NOW - 30000], phone: [NOW - 30000], global: [NOW - 30000], lastSameMs: NOW - 30000 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'resend_too_soon'); assert.strictEqual(r.retryAfterSeconds, 30);
  assert.strictEqual(v.decideSend(NOW, { account: [NOW - 61000], phone: [NOW - 61000], global: [], lastSameMs: NOW - 61000 }).ok, true);
});

test('per-account and per-phone caps: 3 in 10 minutes, 6 in a day', function() {
  var three = [NOW - 2 * M, NOW - 4 * M, NOW - 6 * M];
  assert.strictEqual(v.decideSend(NOW, { account: three, phone: [], global: [], lastSameMs: 0 }).reason, 'too_many_sends');
  assert.strictEqual(v.decideSend(NOW, { account: [], phone: three, global: [], lastSameMs: 0 }).reason, 'too_many_sends');
  var six = [1, 2, 3, 4, 5, 6].map(function(h) { return NOW - h * 3600000; });
  assert.strictEqual(v.decideSend(NOW, { account: six, phone: [], global: [], lastSameMs: 0 }).reason, 'daily_limit');
  assert.strictEqual(v.decideSend(NOW, { account: [], phone: six, global: [], lastSameMs: 0 }).reason, 'daily_limit');
  // yesterday does not count
  var old = six.map(function(t) { return t - 24 * 3600000; });
  assert.strictEqual(v.decideSend(NOW, { account: old, phone: old, global: [], lastSameMs: 0 }).ok, true);
});

test('global cap is 100 a day with an alert flag from the 50th send', function() {
  var fortyNine = []; for (var i = 0; i < 49; i++) fortyNine.push(NOW - i * 1000 - 1000);
  var r = v.decideSend(NOW, { account: [], phone: [], global: fortyNine, lastSameMs: 0 });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.alert, true);
  var hundred = []; for (var j = 0; j < 100; j++) hundred.push(NOW - j * 1000 - 1000);
  assert.strictEqual(v.decideSend(NOW, { account: [], phone: [], global: hundred, lastSameMs: 0 }).reason, 'service_limit');
});

test('code check: not found, expired, locked after five attempts, mismatch counts down, match', function() {
  var h = v.codeHmac('s', 'u', '+1', '111111');
  var row = { code_hmac: h, expires_at: new Date(NOW + 5 * M).toISOString(), attempts: 0 };
  assert.strictEqual(v.checkCode(null, NOW, h).status, 'not_found');
  assert.strictEqual(v.checkCode(Object.assign({}, row, { consumed_at: 'x' }), NOW, h).status, 'not_found');
  assert.strictEqual(v.checkCode(Object.assign({}, row, { expires_at: new Date(NOW - 1).toISOString() }), NOW, h).status, 'expired');
  assert.strictEqual(v.checkCode(Object.assign({}, row, { attempts: 5 }), NOW, h).status, 'locked');
  var miss = v.checkCode(Object.assign({}, row, { attempts: 3 }), NOW, v.codeHmac('s', 'u', '+1', '999999'));
  assert.strictEqual(miss.status, 'mismatch'); assert.strictEqual(miss.attemptsRemaining, 1);
  assert.strictEqual(v.checkCode(row, NOW, h).status, 'ok');
});
