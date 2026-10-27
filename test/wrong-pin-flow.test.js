const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

// 2026-10-28, bugs 2 and 3, end to end. These run the REAL server offline
// (test-support/wrong-pin-harness.js: fake database, fake Twilio, cron jobs
// fired by hand, a settable clock, transcripts chosen per call) over four
// mornings, and read the PIN each dial actually enters from /twiml/answer.
// On the code before this change: the retry entered the PIN it was queued
// with (999903), every repeated-prompt morning came back UNKNOWN and
// retried to the cutoff, and nothing was ever WRONG_PIN or paused for it.

let observed;
function run() {
  if (observed) return observed;
  const port = String(40000 + Math.floor(Math.random() * 9000));
  const outText = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-support', 'wrong-pin-harness.js')], {
    env: Object.assign({}, process.env, { PORT: port, DISABLE_BACKGROUND_JOBS: '' }), timeout: 90000
  }).toString();
  observed = JSON.parse(outText.trim().split('\n').pop());
  assert.ok(!observed.error, observed.error);
  return observed;
}

test('BUG 3: a queued retry dials the PIN on file now, and tells the person where they are now', () => {
  const b = run().bug3;
  assert.strictEqual(b.pinEntered, '123403', 'the corrected PIN, not the 999903 the retry was queued with');
  assert.deepStrictEqual(b.result, ['NO_TEST']);
  assert.strictEqual(b.pinRecorded, '123403');
  assert.strictEqual(b.mailToNew, 1);
  assert.strictEqual(b.mailToOld, 0, 'nothing to the address the retry was queued with');
});

test('BUG 3: a retry queued before the schedule moved to Fort Bend is not dialled', () => {
  const b = run().bug3;
  assert.strictEqual(b.dials, 1, 'only the Montgomery schedule was dialled');
  assert.strictEqual(b.fortBendRetryLeft, false, 'and the stale retry is cleared');
});

test('WRONG_PIN: one hearing is a retry on the same PIN, silent; the second is the verdict', () => {
  const w = run().w1a;
  assert.strictEqual(w.pin, '111101');
  assert.deepStrictEqual(w.afterFirst, { rows: [], pending: 'WRONG_PIN', pendingPin: '111101', mail: 0, hearings: 1 });
  assert.strictEqual(w.retryDials, 1);
  assert.strictEqual(w.retryPin, '111101');
  const a = w.afterSecond;
  assert.deepStrictEqual(a.rows, ['WRONG_PIN'], 'one row for the morning');
  assert.strictEqual(a.billed, false);
  assert.strictEqual(a.charges, 0, 'never billed');
  assert.strictEqual(a.pendingLeft, false, 'the retry sequence ends');
  assert.strictEqual(a.count, 1);
  assert.strictEqual(a.enabled, true, 'one morning does not pause');
  assert.strictEqual(a.mail.length, 1);
  assert.match(a.mail[0], /didn't accept your PIN/);
});

test('WRONG_PIN reaches Today as WRONG_PIN, not charged', () => {
  assert.deepStrictEqual(run().w1a.today, { status: 200, result: 'WRONG_PIN', billed: false });
});

test('Call Now: one hearing is the answer, and it never counts toward the pause', () => {
  const c = run().callNow;
  assert.strictEqual(c.status, 200);
  assert.deepStrictEqual(c.rows, ['WRONG_PIN']);
  assert.strictEqual(c.mail.length, 1);
  assert.strictEqual(c.count, 0);
  assert.strictEqual(c.enabled, true);
});

test('two WRONG_PIN mornings pause as wrong_pin: calls stop, person and admins told', () => {
  const w = run().w1b;
  assert.deepStrictEqual(w.rows, ['WRONG_PIN', 'WRONG_PIN']);
  assert.strictEqual(w.enabled, false);
  assert.strictEqual(w.reason, 'wrong_pin');
  assert.strictEqual(w.count, 2);
  assert.strictEqual(w.jobStopped, true);
  assert.strictEqual(w.pendingLeft, false);
  assert.match(w.mail[w.mail.length - 1], /paused — the hotline rejected your PIN/);
  assert.strictEqual(w.adminSms, 1);
});

test('the wrong_pin pause: resume refused, a same-PIN save keeps it, only a different PIN lifts it', () => {
  const w = run().w1b;
  assert.deepStrictEqual(w.resume, { status: 409, code: 'wrong_pin' });
  assert.deepStrictEqual(w.samePinSave, { status: 200, enabled: false, reason: 'wrong_pin' });
  assert.deepStrictEqual(w.newPinSave, { status: 200, enabled: true, reason: null, count: 0 }, 'the count starts over with the new PIN');
});

test('no verdict until another account has got through that morning', () => {
  const w = run().w5;
  assert.deepStrictEqual(w.afterTwoAlone, { rows: [], pending: 'WRONG_PIN', mail: 0 }, 'two hearings, nobody else through: still retrying, still marked');
  assert.strictEqual(w.thirdDials, 1);
  assert.deepStrictEqual(w.afterProof, { rows: ['WRONG_PIN'], pendingLeft: false, count: 1, mail: 1 });
});

test('THREE ACCOUNTS ON ONE MORNING IS OURS: no WRONG_PIN, no count, no notice, one admin alert', () => {
  const f = run().fault;
  assert.deepStrictEqual(f.afterFirstHearings, ['WRONG_PIN', 'WRONG_PIN', 'UNKNOWN'], 'the third hearing crosses SYSTEM_FAULT_ACCOUNTS');
  assert.strictEqual(f.retryDials, 3);
  for (const a of f.afterRetries) {
    assert.deepStrictEqual(a, { rows: [], pending: 'UNKNOWN', count: 0, mail: 0 }, 'an ordinary no-result morning, still retrying');
  }
  assert.strictEqual(f.wrongPinRowsToday, 0);
  assert.strictEqual(f.alerts, 1, 'one alert a day');
});

test('a morning that runs out before confirming is recorded as UNKNOWN', () => {
  assert.deepStrictEqual(run().cutoff, { dials: 0, w6: ['UNKNOWN'], pendingLeft: false });
});

test('hearings go to pin_reprompts; call_attempts still holds only dials', () => {
  const o = run();
  assert.ok(o.hearingsRecorded >= 10);
  assert.deepStrictEqual(o.attemptOutcomes, ['dialed']);
});

// --- 2026-10-28, Dave's review. Each of these failed on the deployed code
// (9934bab): the demo-only morning was judged, two WRONG_PINs three weeks
// apart paused, pause-then-resume and delete-then-resave both lifted a PIN
// pause, and a restart re-sent the fault alert.

test('ONLY THE DEMO ACCOUNT (and one of ours) HAS RESOLVED: the 6:07 caller is not judged', () => {
  const d = run().demoOnly;
  assert.strictEqual(d.demoDialled, 0, 'the demo morning dials nothing');
  assert.ok(['MUST_TEST', 'NO_TEST'].includes(d.demoRow[0]), 'and writes a Montgomery result — which used to count as proof the line works');
  assert.deepStrictEqual(d.afterTwo, { rows: [], pending: 'WRONG_PIN', mail: 0 }, 'two hearings, no subscriber through: still retrying, nobody told');
  assert.deepStrictEqual(d.afterSubscriber, { rows: ['WRONG_PIN'], count: 1 }, 'a subscriber getting through is the proof');
});

test('two WRONG_PINs three weeks apart do not pause; on consecutive days they do', () => {
  const c = run().consecutive;
  assert.deepStrictEqual(c.threeWeeksApart, { count: 1, day: '2026-11-03', enabled: true });
  assert.deepStrictEqual(c.nextDay, { count: 2, enabled: false, reason: 'wrong_pin' });
});

for (const [key, reason] of [['bypassWrongPin', 'wrong_pin'], ['bypassPinExpired', 'pin_expired']]) {
  test(reason + ': pause-then-resume does not lift it', () => {
    const b = run()[key];
    assert.deepStrictEqual(b.pause, { status: 200, pauseReason: reason, stored: reason }, 'the reason is kept');
    assert.deepStrictEqual(b.resume, { status: 409, code: reason, enabled: false });
  });
  test(reason + ': delete-then-resave on the same PIN comes back paused; a different PIN runs', () => {
    const b = run()[key];
    assert.deepStrictEqual(b.deleted, { status: 200, gone: true });
    assert.strictEqual(b.resaveSame.status, 200);
    assert.strictEqual(b.resaveSame.enabled, false);
    assert.strictEqual(b.resaveSame.reason, reason);
    assert.deepStrictEqual(b.resaveSame.counts, reason === 'wrong_pin' ? [0, 2] : [2, 0], 'with the count that paused it');
    assert.deepStrictEqual(b.resaveNew, { status: 200, enabled: true, reason: null });
    assert.strictEqual(b.openPauses, 0, 'and no pause is left open behind a running schedule');
  });
}

test('the once-a-day fault alert survives a restart', () => {
  const o = run();
  assert.strictEqual(o.fault.claimRecorded, 1, 'the day\'s send is claimed in the database');
  assert.deepStrictEqual(o.alertAfterRestart, { faultSeen: 'UNKNOWN', newAlerts: 0 }, 'a claim made before a restart holds');
});

// Dave's follow-ups, same day. On the deployed code: two expiries three
// weeks apart paused, and a PIN-paused schedule moved to Fort Bend stayed
// paused with nothing able to lift it — while moving back to Montgomery on
// the same PIN read as a PIN change and resumed it.

test('the expired-PIN count is consecutive too', () => {
  const p = run().pinExpired;
  assert.deepStrictEqual(p.threeWeeksApart, { rows: ['PIN_EXPIRED'], count: 1, day: '2026-11-05', enabled: true });
  assert.deepStrictEqual(p.nextDay, { count: 2, enabled: false, reason: 'pin_expired' });
});

test('a PIN pause lifts on a move to Fort Bend; back to Montgomery on the same PIN it returns; a new PIN runs', () => {
  const f = run().fortBend;
  assert.deepStrictEqual(f.toFortBend, { status: 200, county: 'ftbend', enabled: true, reason: null, counts: [0, 0] });
  assert.deepStrictEqual(f.backSamePin, { status: 200, enabled: false, reason: 'wrong_pin' }, 'the round trip is not a way past');
  assert.deepStrictEqual(f.backNewPin, { status: 200, enabled: true, reason: null });
});
