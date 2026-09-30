const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-09-30: the first PIN_EXPIRED of a streak was silent. The person got no
// verdict and no message that morning — a silent morning is the worst
// outcome we have. It now sends a hedged notice (one occurrence may be a
// mishear); the auto-pause still waits for the second in a row.

function handlerBody() {
  const i = server.indexOf('async function handlePinExpiredResult(');
  assert.ok(i > 0, 'the handler should be findable');
  const end = server.indexOf('\n}\n', i);
  return server.slice(i, end);
}

function firstNotice() {
  const m = /var PIN_EXPIRED_FIRST_NOTICE = ('(?:[^'\\]|\\.)*');/.exec(server);
  assert.ok(m, 'the first-occurrence notice is a named constant');
  return m[1];
}

test('the first PIN_EXPIRED sends a notice instead of returning silently', () => {
  const body = handlerBody();
  const below = body.indexOf('if (newCount < PIN_EXPIRED_STREAK_THRESHOLD)');
  assert.ok(below > 0);
  const branch = body.slice(below, body.indexOf('return;', below));
  assert.match(branch, /notify\([^;]*PIN_EXPIRED_FIRST_NOTICE, 'pin_expired_first'\)/,
    'below the threshold the person is told, not left with nothing');
});

test('a failed streak read still sends the notice', () => {
  const body = handlerBody();
  const fail = body.indexOf('if (schedRes.error || !schedRes.data)');
  assert.ok(fail > 0);
  const branch = body.slice(fail, body.indexOf('return;', fail));
  assert.match(branch, /PIN_EXPIRED_FIRST_NOTICE/, 'a DB hiccup must not produce a silent morning');
});

test('the notice is hedged, not a definitive alarm', () => {
  const msg = firstNotice();
  assert.match(msg, /couldn\\'t confirm your result/i, 'leads with what we could not do');
  assert.match(msg, /call the hotline yourself/i, 'and the action the person takes');
  assert.match(msg, /mishear/i, 'says it may be a mishear');
  assert.match(msg, /\+1 \(936\) 283-4848/, 'gives the Montgomery line to call');
  assert.ok(!/🚨|TEST REQUIRED|paused your/i.test(msg), 'no alarm, and no claim that anything was paused');
});

test('the auto-pause still waits for the second in a row', () => {
  assert.match(server, /var PIN_EXPIRED_STREAK_THRESHOLD = 2;/);
  assert.match(handlerBody(), /paused_reason: 'pin_expired'/);
});

test('the notice never pushes and is never quieted', () => {
  const body = handlerBody();
  assert.ok(!/tryPushFirst/.test(body), 'an action item goes by SMS and email, like UNKNOWN (§2)');
  assert.ok(!/quiet_mode|pushAllowed/.test(body), 'quiet mode silences NO_TEST only');
});

test('the email carries its own subject', () => {
  assert.match(server, /pin_expired_first:\s*\{ subject: 'We couldn\\'t confirm your result today — call the hotline', stamp: true/);
});
