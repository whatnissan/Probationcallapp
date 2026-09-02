const test = require('node:test');
const assert = require('node:assert');
const { fallbackFieldsFor } = require('../lib/push');

const NOW = Date.parse('2026-09-02T11:03:05Z');

test('no device: the caller delivers, and the row is already marked sent so the sweep cannot text again', function() {
  var f = fallbackFieldsFor('no_device', NOW, 10);
  assert.strictEqual(f.fallback_reason, 'no_device');
  assert.strictEqual(f.fallback_sent_at, new Date(NOW).toISOString());
  assert.strictEqual(f.fallback_due_at, new Date(NOW).toISOString());
});

test('send failed: same ownership — caller delivers, sweep stays out', function() {
  var f = fallbackFieldsFor('send_failed', NOW, 10);
  assert.strictEqual(f.fallback_reason, 'send_failed');
  assert.ok(f.fallback_sent_at, 'must be marked sent by the caller');
});

test('push accepted: the sweep owns delivery, due in N minutes, not yet sent', function() {
  var f = fallbackFieldsFor('sent', NOW, 10);
  assert.strictEqual(f.fallback_sent_at, null);
  assert.strictEqual(f.fallback_reason, null);
  assert.strictEqual(f.fallback_due_at, new Date(NOW + 10 * 60000).toISOString());
});

test('the sweep predicate and the caller-owned rows are disjoint', function() {
  // runPushFallbackSweep selects fallback_sent_at IS NULL AND acked_at IS NULL AND due <= now.
  ['no_device', 'send_failed'].forEach(function(o) {
    var f = fallbackFieldsFor(o, NOW, 10);
    assert.notStrictEqual(f.fallback_sent_at, null, o + ' row must never match the sweep');
  });
});
