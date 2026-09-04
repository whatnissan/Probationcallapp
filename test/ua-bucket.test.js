const test = require('node:test');
const assert = require('node:assert');
const { uaBucket, uaSlug } = require('../lib/ua-bucket');

// The question this exists to answer is "what IS that client" — so the
// cases that matter are the ones that distinguish our own app from a
// browser from a script.
test('our iOS app is distinguishable from any other URLSession client', function() {
  assert.strictEqual(uaBucket('ProbationCall/1.2 CFNetwork/1494.0.7 Darwin/23.4.0'), 'ios-app');
  // Same networking stack, not our app. If these collided, "is it the iOS
  // app looping" would be unanswerable — which is the whole point.
  assert.strictEqual(uaBucket('SomeOtherApp/3 CFNetwork/1494.0.7 Darwin/23.4.0'), 'ios-urlsession');
});

test('known crawlers land in their own bucket', function() {
  assert.strictEqual(uaBucket('Mozilla/5.0 (compatible; Grok/1.0; +https://x.ai)'), 'grok');
  assert.strictEqual(uaBucket('GPTBot/1.1 (+https://openai.com/gptbot)'), 'gptbot');
  assert.strictEqual(uaBucket('Bytespider'), 'bytespider');
  assert.strictEqual(uaBucket('Mozilla/5.0 (compatible; ClaudeBot/1.0)'), 'claudebot');
  // A crawler UA that starts with Mozilla must not fall through to 'browser'.
  assert.strictEqual(uaBucket('Mozilla/5.0 (compatible; bingbot/2.0)'), 'bingbot');
});

test('an ordinary browser is one bucket, because it tells us nothing', function() {
  assert.strictEqual(uaBucket('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'), 'browser');
  assert.strictEqual(uaBucket('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1'), 'browser');
});

test('an unknown agent keeps a slug — that is where a new crawler lands', function() {
  assert.strictEqual(uaBucket('WeirdThing/9.1 (+http://example.com)'), 'ua?:WeirdThing');
  // 'fetch' in a name is treated as a self-declared bot, deliberately.
  assert.strictEqual(uaBucket('WeirdFetcher/9.1'), 'bot?:WeirdFetcher');
  assert.strictEqual(uaBucket('SomeNewBot/2'), 'bot?:SomeNewBot');
  assert.strictEqual(uaBucket(''), 'none');
  assert.strictEqual(uaBucket(undefined), 'none');
  assert.strictEqual(uaBucket(null), 'none');
});

// A log key built from a stranger's header is a cardinality and injection
// surface if it is not bounded on both.
test('a slug is bounded and cannot carry a log line apart', function() {
  const nasty = 'A'.repeat(500) + ' | [REQ] fake line | \n\r';
  const b = uaBucket(nasty);
  assert.ok(b.length <= 25, 'bucket stayed short: ' + b.length);
  assert.ok(!/[\n\r|]/.test(b), 'no newlines or pipes can reach the log line');
  assert.strictEqual(uaSlug('x'.repeat(100)).length, 20);
  assert.strictEqual(uaSlug('!!!!'), 'x');
});

test('the bucket set is closed — every entry is a short stable name', function() {
  const { UA_BUCKETS } = require('../lib/ua-bucket');
  for (const [name, re] of UA_BUCKETS) {
    assert.ok(/^[a-z0-9?:-]{2,14}$/.test(name), 'bucket name is a grep target: ' + name);
    assert.ok(re instanceof RegExp);
  }
});
