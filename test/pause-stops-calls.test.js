const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

// 2026-10-27: pausing did not stop calls. A paused Montgomery user kept being
// dialled, charged and told the result every morning until the next deploy.
// These run the REAL server offline (test-support/pause-calls-harness.js:
// fake database, fake Twilio that records every dial, cron jobs captured and
// fired by hand) and check what actually happens. Each scenario failed on the
// code before the fix — the morning job dialled the paused user, and queued
// retries dialled paused and STOP-paused users.

let observed;
function run() {
  if (observed) return observed;
  const port = String(40000 + Math.floor(Math.random() * 9000));
  const outText = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-support', 'pause-calls-harness.js')], {
    env: Object.assign({}, process.env, { PORT: port, DISABLE_BACKGROUND_JOBS: '' }), timeout: 60000
  }).toString();
  observed = JSON.parse(outText.trim().split('\n').pop());
  assert.ok(!observed.error, observed.error);
  return observed;
}

test('a paused user is not dialled by the morning job', () => {
  const o = run();
  assert.strictEqual(o.jobsBuiltAtBoot, true);
  assert.strictEqual(o.pauseStatus, 200);
  assert.strictEqual(o.pauseStoppedJob, true, 'the pause stops the job (defence in depth)');
  assert.strictEqual(o.pausedDials, 0, 'even a stale job that fires anyway is refused at dial time');
  assert.strictEqual(o.pausedCharges, 0);
  assert.strictEqual(o.enabledDials, 1, 'control: an enabled user is dialled by the same harness');
});

test('a pause between queueing a retry and the retry firing stops the retry', () => {
  const o = run();
  assert.strictEqual(o.pauseClearedRetry, true, 'the pause clears queued retries');
  assert.strictEqual(o.retryDials, 1, 'a retry queued again after the pause does not dial; the enabled user\'s retry does');
  assert.strictEqual(o.pausedRetryLeft, false, 'the paused user\'s retry is deleted, not left to fire or final-fail');
  assert.strictEqual(o.enabledRetryLeased, true);
});

test('a STOP-paused user with no email is not dialled and not charged', () => {
  const o = run();
  assert.deepStrictEqual(o.stopPause, { enabled: false, reason: 'sms_opted_out' });
  assert.strictEqual(o.stopStoppedJob, true);
  assert.strictEqual(o.stopClearedRetry, true, 'STOP clears the morning\'s queued retries');
  assert.strictEqual(o.stopRetryDials, 0, 'a retry queued before STOP does not dial');
  assert.strictEqual(o.stopDials, 0, 'the morning job does not dial');
  assert.strictEqual(o.stopCharges, 0);
  assert.strictEqual(o.stopCreditsUnchanged, true);
});

test('Fort Bend still behaves: enabled users answered and charged, paused ones never touched', () => {
  // Correct before this change; pinned so it stays that way. The office's
  // answer is queued per ENABLED user (pending_notifications) and delivered
  // at each person's time, re-reading the schedule then.
  const o = run();
  assert.strictEqual(o.ftStatus, 200);
  assert.deepStrictEqual(o.ftQueued, ['F1', 'F3'], 'a user paused before the answer is not queued');
  assert.strictEqual(o.ftEnabledRows, 1);
  assert.strictEqual(o.ftEnabledCharges, 1);
  assert.strictEqual(o.ftPausedBeforeRows, 0);
  assert.strictEqual(o.ftPausedBeforeCharges, 0);
  assert.strictEqual(o.ftPausedAfterQueueRows, 0, 'paused between queueing and delivery: not delivered');
  assert.strictEqual(o.ftPausedAfterQueueCharges, 0, 'and not charged');
  assert.strictEqual(o.ftDials, 0, 'Fort Bend users are never dialled one by one');
});
