const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { detectPinReprompt, countIdPrompts, detectPinExpired } = require('../lib/detection');
const wp = require('../lib/wrong-pin');
const { pauseStateOnSave } = require('../lib/schedule-pause');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// WRONG_PIN (Dave, 2026-10-28). The transcripts below are written for the
// test, shaped like the hotline's call flow — no recording's words are used.

const PROMPT = 'Please enter your ID number followed by the pound sign.';
const ACCEPTED_NO = 'Welcome. ' + PROMPT + ' Thank you. You do not need to test today. Goodbye.';
const ACCEPTED_MUST = 'Welcome. ' + PROMPT + ' Thank you. You are required to test today. Goodbye.';
const EXPIRED = 'Welcome. ' + PROMPT + ' This ID number has expired. Please contact your officer.';
const REJECTED = 'Welcome. ' + PROMPT + ' ' + PROMPT + ' ' + PROMPT;

test('detector: the ID prompt heard twice or more, and nothing said after an ID is accepted', () => {
  assert.strictEqual(countIdPrompts(REJECTED), 3);
  assert.strictEqual(detectPinReprompt(REJECTED), true);
  assert.strictEqual(detectPinReprompt('Welcome. ' + PROMPT + ' ' + PROMPT), true, 'twice is enough');
  assert.strictEqual(detectPinReprompt(ACCEPTED_NO), false, 'one prompt then a result: accepted');
  assert.strictEqual(detectPinReprompt(ACCEPTED_MUST), false);
  assert.strictEqual(detectPinReprompt(PROMPT), false, 'one prompt and nothing else is an ordinary no-result');
  assert.strictEqual(detectPinReprompt(''), false);
  assert.strictEqual(detectPinReprompt(null), false);
});

test('detector: a result or an expiry heard anywhere in the call is never a rejected PIN', () => {
  assert.strictEqual(detectPinReprompt(PROMPT + ' ' + PROMPT + ' You do not need to test today.'), false);
  assert.strictEqual(detectPinReprompt(PROMPT + ' ' + PROMPT + ' You are required to test today.'), false);
  const expiredTwice = PROMPT + ' ' + PROMPT + ' This ID number has expired.';
  assert.strictEqual(detectPinExpired(expiredTwice), true);
  assert.strictEqual(detectPinReprompt(expiredTwice), false, 'PIN_EXPIRED keeps its own path');
  assert.strictEqual(detectPinReprompt(EXPIRED), false);
});

// --- the decision ---------------------------------------------------------

const SCHED = { scheduled: true, earlierSamePin: true, accountsRepromptedToday: 1, othersResolvedToday: 4 };
const NOW = { scheduled: false, earlierSamePin: false, accountsRepromptedToday: 1, othersResolvedToday: 4 };
const v = (o) => wp.repromptVerdict(o);

test('a scheduled morning: confirmed on the second hearing of the same PIN, with others through', () => {
  assert.deepStrictEqual(v(SCHED), { result: 'WRONG_PIN', final: true, why: 'confirmed' });
  assert.deepStrictEqual(v(Object.assign({}, SCHED, { earlierSamePin: false })), { result: 'WRONG_PIN', final: false, why: 'first_hearing' },
    'one hearing is a retry, not a verdict — a dropped tone sounds the same');
});

test('MANY ACCOUNTS AT ONCE IS OURS: SYSTEM_FAULT_ACCOUNTS is 3, and at 3 nobody gets WRONG_PIN', () => {
  // The threshold, by value. Changing it is a decision, not a refactor:
  // every morning on file has had at most ONE account hear the repeated
  // prompt, and Montgomery dials 5–9 accounts a morning, so a fault reaching
  // every call crosses 3 early while two genuine typos on one morning still
  // get their answer. See lib/wrong-pin.js rule 1.
  assert.strictEqual(wp.SYSTEM_FAULT_ACCOUNTS, 3);

  assert.deepStrictEqual(v(Object.assign({}, SCHED, { accountsRepromptedToday: 2 })), { result: 'WRONG_PIN', final: true, why: 'confirmed' },
    'two accounts on one morning: still their PINs');
  for (const n of [3, 4, 9]) {
    assert.deepStrictEqual(v(Object.assign({}, SCHED, { accountsRepromptedToday: n })), { result: 'UNKNOWN', final: false, why: 'system_fault' },
      n + ' accounts: our problem — the morning retries as an ordinary no-result');
    assert.deepStrictEqual(v(Object.assign({}, NOW, { accountsRepromptedToday: n })), { result: 'UNKNOWN', final: true, why: 'system_fault' },
      n + ' accounts: Call Now is not told its PIN is wrong either');
  }
  // It wins over everything else, including a confirmed second hearing with
  // plenty of other accounts through.
  assert.strictEqual(v({ scheduled: true, earlierSamePin: true, accountsRepromptedToday: 3, othersResolvedToday: 8 }).why, 'system_fault');
});

test('THE LINE MUST HAVE WORKED FOR SOMEONE ELSE TODAY: the first call of the day cannot be judged alone', () => {
  // 6:00 account, morning-wide fault: two hearings by 6:05, nobody else
  // dialled yet, count at 1. Without this rule it would be told its PIN is
  // wrong — and paused on the second such morning.
  const early = { scheduled: true, earlierSamePin: true, accountsRepromptedToday: 1, othersResolvedToday: 0 };
  assert.deepStrictEqual(v(early), { result: 'WRONG_PIN', final: false, why: 'line_unproven' }, 'keeps retrying, still marked');
  assert.deepStrictEqual(v(Object.assign({}, early, { othersResolvedToday: 1 })), { result: 'WRONG_PIN', final: true, why: 'confirmed' },
    'one other account through is the proof');
  assert.deepStrictEqual(v(Object.assign({}, NOW, { othersResolvedToday: 0 })), { result: 'UNKNOWN', final: true, why: 'line_unproven' },
    'Call Now with nothing to compare against is not told its PIN is wrong');
});

test('Call Now: one hearing is the answer (no retries; the person asked now)', () => {
  assert.deepStrictEqual(v(NOW), { result: 'WRONG_PIN', final: true, why: 'call_now' });
});

test('a morning that runs out before confirming is UNKNOWN, never WRONG_PIN', () => {
  assert.strictEqual(wp.finalFailResult('WRONG_PIN'), 'UNKNOWN');
  for (const r of ['UNKNOWN', 'CALL_FAILED', 'HOTLINE_DOWN', 'TRANSCRIBER_DOWN']) assert.strictEqual(wp.finalFailResult(r), r);
});

test('the pause: 2 WRONG_PIN mornings', () => {
  assert.strictEqual(wp.WRONG_PIN_PAUSE_MORNINGS, 2);
  assert.strictEqual(wp.pausesAfter(1), false);
  assert.strictEqual(wp.pausesAfter(2), true);
  assert.strictEqual(wp.pausesAfter(3), true);
});

test('a wrong_pin pause is lifted by a different PIN and nothing else', () => {
  const paused = { id: 's1', enabled: false, paused_reason: 'wrong_pin', pin: '111111' };
  const kept = { enabled: false, paused_reason: 'wrong_pin' };
  assert.deepStrictEqual(pauseStateOnSave(paused, { pin: '222222', notify_method: 'email', notify_email: 'a@b.c' }, {}), { enabled: true, paused_reason: null });
  assert.deepStrictEqual(pauseStateOnSave(paused, { pin: '111111', notify_method: 'email', notify_email: 'a@b.c' }, {}), kept, 'same PIN: still paused');
  assert.deepStrictEqual(pauseStateOnSave(paused, { pin: null, notify_method: 'sms', notify_number: '+15555550100' }, {}), kept, 'an unrelated save: still paused');
  assert.deepStrictEqual(pauseStateOnSave(paused, { pin: '111111' }, { credits: 50 }), kept, 'credits do not help');
});

// --- wiring -----------------------------------------------------------------

const fnBody = (name) => { const i = server.indexOf(name); assert.ok(i > 0, name); return server.slice(i, server.indexOf('\n}\n', i)); };

test('resume refuses wrong_pin with 409 wrong_pin, before the credits check', () => {
  const r = server.slice(server.indexOf("app.post('/api/v1/schedule/resume'"), server.indexOf("app.post('/api/v1/schedule/resume'") + 3000);
  const at = r.indexOf("paused_reason === 'wrong_pin'");
  assert.ok(at > 0);
  assert.match(r.slice(at, at + 300), /v1Error\(res, 409, 'wrong_pin',/);
  assert.ok(at < r.indexOf("from('profiles').select('credits')"), 'credits would not help');
});

test('the repeated prompt is checked only for Montgomery, and never ahead of a result or an expiry', () => {
  const pr = server.slice(server.indexOf('async function processRecording('));
  assert.match(pr, /var reprompt = \(!isFtbend && config\.userId && detectPinReprompt\(transcript\)\) \? await decideReprompt\(config\) : null;/);
  const chain = pr.slice(pr.indexOf('if (detectPinExpired(transcript)) {'));
  const order = ["if (detectPinExpired(transcript)) {", "KEYWORDS.MUST_TEST.some(", "KEYWORDS.NO_TEST.some(",
    "reprompt.result === 'WRONG_PIN' && !reprompt.final", "} else if (reprompt && reprompt.result === 'WRONG_PIN') {", "Unknown result for"];
  for (let i = 1; i < order.length; i++) assert.ok(chain.indexOf(order[i - 1]) < chain.indexOf(order[i]), order[i - 1] + ' before ' + order[i]);
});

test('WRONG_PIN never bills, ends the retry sequence, and has its own count', () => {
  const pr = server.slice(server.indexOf('async function processRecording('));
  assert.match(pr, /if \(\(result === 'MUST_TEST' \|\| result === 'NO_TEST'\) && config\.userId\) \{\s*var billKey/, 'billing gate unchanged');
  assert.match(pr, /result === 'PIN_EXPIRED' \|\| result === 'WRONG_PIN'\)\) \{\s*await supabase\.from\('pending_retries'\)\.delete\(\)/);
  assert.match(fnBody('async function checkConsecutiveUnknown('), /\.neq\('result', 'WRONG_PIN'\)/, 'not part of the no-result streak');
  assert.match(server, /no_credit_skip_count: 0, consecutive_pin_expired: 0, consecutive_wrong_pin: 0/, 'a result heard resets it');
  assert.match(server, /\.in\('result', \['MUST_TEST', 'NO_TEST', 'PIN_EXPIRED', 'WRONG_PIN'\]\)/, 'a resolved morning for the orphan-retry guard');
});

test('hearings are counted from pin_reprompts — call_attempts stays one row per dial', () => {
  const d = fnBody('async function decideReprompt(');
  assert.match(d, /from\('pin_reprompts'\)\.insert\(/);
  assert.ok(!/call_attempts/.test(d.replace(/\/\/.*$/gm, '')), 'decideReprompt never writes or reads call_attempts');
  assert.ok(!/outcome: 'pin_reprompt'/.test(server));
});

test('the pause handler tags wrong_pin and stops the calls', () => {
  const h = fnBody('async function handleWrongPinResult(');
  assert.match(h, /update\(\{ enabled: false, paused_reason: 'wrong_pin' \}\)/);
  assert.match(h, /await stopScheduledCalls\(userId, '\[WRONG-PIN\]'\);/);
  assert.match(h, /wrongPin\.pausesAfter\(newCount\)/);
});

// --- 2026-10-28, Dave's review --------------------------------------------

const { nextConsecutiveDayCount } = require('../lib/time');

test('"two mornings in a row" means consecutive days', () => {
  const n = (count, lastDay) => nextConsecutiveDayCount({ count, lastDay, today: '2026-10-28' });
  assert.strictEqual(n(1, '2026-10-27'), 2, 'yesterday, then today: two in a row');
  assert.strictEqual(n(1, '2026-10-07'), 1, 'three weeks apart: starts over');
  assert.strictEqual(n(1, '2026-10-26'), 1, 'an UNKNOWN, skipped or paused day in between: starts over');
  assert.strictEqual(n(0, '2026-10-27'), 1, 'a result heard since (count reset to 0): starts over');
  assert.strictEqual(n(0, null), 1, 'the first one');
  assert.strictEqual(n(1, '2026-10-28'), 1, 'a second verdict the same day is not another morning');
  assert.strictEqual(nextConsecutiveDayCount({ count: 1, lastDay: '2026-10-31', today: '2026-11-01' }), 2, 'across a month end, which is also the DST change');
  assert.strictEqual(wp.pausesAfter(n(1, '2026-10-07')), false, 'so three weeks apart never pauses');
});

test('both PIN counts are kept by day, on the one rule', () => {
  const h = fnBody('async function handleWrongPinResult(');
  assert.match(h, /select\('consecutive_wrong_pin, last_wrong_pin_day, enabled'\)/);
  assert.match(h, /nextConsecutiveDayCount\(\{ count: schedRes\.data\.consecutive_wrong_pin, lastDay: schedRes\.data\.last_wrong_pin_day, today: wpToday \}\)/);
  assert.match(h, /update\(\{ consecutive_wrong_pin: newCount, last_wrong_pin_day: wpToday \}\)/);
  // The expired-PIN count had the identical flaw (Dave: fix both).
  const e = fnBody('async function handlePinExpiredResult(');
  assert.match(e, /select\('consecutive_pin_expired, last_pin_expired_day, enabled'\)/);
  assert.match(e, /nextConsecutiveDayCount\(\{ count: schedRes\.data\.consecutive_pin_expired, lastDay: schedRes\.data\.last_pin_expired_day, today: peToday \}\)/);
  assert.match(e, /update\(\{ consecutive_pin_expired: newCount, last_pin_expired_day: peToday \}\)/);
  assert.ok(!/\(schedRes\.data\.consecutive_pin_expired \|\| 0\) \+ 1/.test(e), 'no plain +1 left');
});

test('rule 2 counts subscribers only: the demo account and our own accounts are never the proof', () => {
  const d = fnBody('async function decideReprompt(');
  assert.match(d, /excluded = await countyPoolExcludedIds\(\);/, 'THE canonical exclusion set: demo, admins, dev and internal emails');
  assert.match(d, /if \(excluded && !excluded\[r\.user_id\]\) others\[r\.user_id\] = true;/, 'and nobody counts if it cannot be read');
  assert.match(d, /var readFailed = !!\(heard\.error \|\| resolved\.error \|\| excludedError\);/, 'an unreadable exclusion set is an unproven line');
});

test('the fault alert\'s once-a-day limit is a database claim, not memory', () => {
  const a = fnBody('async function alertAdminRepromptFault(');
  assert.match(a, /if \(!\(await claimDailyAlert\('wrong_pin_fault', today\)\)\) return;/);
  const c = fnBody('async function claimDailyAlert(');
  assert.match(c, /from\('admin_alert_days'\)\.insert\(\{ alert: alert, day: day \}\)/);
  assert.match(c, /if \(r\.error\.code === '23505'\) return false;/, 'already claimed today');
  assert.match(c, /sending anyway:', r\.error\.message\);\s*return true;\s*$/, 'any other failure sends anyway');
});
