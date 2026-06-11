const test = require('node:test');
const assert = require('node:assert');

const { pendingCallToRow, rowToPendingCall } = require('../lib/pending');

// A Montgomery scheduled-morning call config, as initiateCall builds it.
const montConfig = {
  callSid: 'CA123',
  userId: '58406a9f-0000-0000-0000-000000000000',
  county: 'montgomery',
  pin: '123456',
  targetNumber: '+19362834848',
  notifyNumber: '+15551234567',
  notifyEmail: 'user@example.com',
  notifyMethod: 'both',
  retryCount: 0,
  isScheduledMorning: true
};

// A Fort Bend daily system call config, as ftbendCallOffice builds it.
const ftConfig = {
  callSid: 'CA999',
  isFtbendDaily: true,
  officeId: 'rosenberg2',
  targetNumber: '+12812383671',
  hasPhases: true
};

test('Montgomery config survives a round-trip through the DB row', function() {
  var recovered = rowToPendingCall(pendingCallToRow('call_1', montConfig));
  // Every field the recording/status webhooks rely on must be preserved.
  assert.strictEqual(recovered.callSid, 'CA123');
  assert.strictEqual(recovered.userId, montConfig.userId);
  assert.strictEqual(recovered.county, 'montgomery');
  assert.strictEqual(recovered.pin, '123456');
  assert.strictEqual(recovered.targetNumber, '+19362834848');
  assert.strictEqual(recovered.notifyNumber, '+15551234567');
  assert.strictEqual(recovered.notifyEmail, 'user@example.com');
  assert.strictEqual(recovered.notifyMethod, 'both');
  assert.strictEqual(recovered.isScheduledMorning, true);
  assert.strictEqual(recovered.isFtbendDaily, false);
  assert.strictEqual(recovered.recoveredFromDb, true);
});

test('Fort Bend daily config survives a round-trip (office + phases preserved)', function() {
  var recovered = rowToPendingCall(pendingCallToRow('ftbend_rosenberg2_1', ftConfig));
  assert.strictEqual(recovered.isFtbendDaily, true);
  assert.strictEqual(recovered.officeId, 'rosenberg2');
  assert.strictEqual(recovered.hasPhases, true);
  assert.strictEqual(recovered.targetNumber, '+12812383671');
  // No user on a system call.
  assert.strictEqual(recovered.userId, undefined);
});

test('row uses snake_case columns and a non-null primary key', function() {
  var row = pendingCallToRow('call_42', montConfig);
  assert.strictEqual(row.call_id, 'call_42');
  assert.strictEqual(row.is_scheduled_morning, true);
  assert.strictEqual(row.user_id, montConfig.userId);
  // Booleans must be real booleans (not undefined) so the DB column is happy.
  assert.strictEqual(row.is_ftbend_daily, false);
  assert.strictEqual(row.has_phases, false);
});

test('missing optional fields become null in the row, not undefined', function() {
  var row = pendingCallToRow('call_x', { callSid: 'CA1' });
  assert.strictEqual(row.user_id, null);
  assert.strictEqual(row.pin, null);
  assert.strictEqual(row.notify_email, null);
  assert.strictEqual(row.retry_count, 0);
});
