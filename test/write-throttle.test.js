const test = require('node:test');
const assert = require('node:assert');
const { createThrottle } = require('../lib/write-throttle');

test('the first write goes through, repeats inside the window do not', function() {
  const t = createThrottle(10 * 60 * 1000);
  assert.strictEqual(t.take('u1', 0), true);
  assert.strictEqual(t.take('u1', 1), false);
  assert.strictEqual(t.take('u1', 9 * 60 * 1000), false);
  assert.strictEqual(t.take('u1', 10 * 60 * 1000), true);   // window elapsed
});

test('a request loop cannot write more than once per window', function() {
  // The incident: hundreds of PATCHes per second on one row.
  const t = createThrottle(10 * 60 * 1000);
  let writes = 0;
  for (let ms = 0; ms < 10 * 60 * 1000; ms += 20) if (t.take('u1', ms)) writes++;
  assert.strictEqual(writes, 1, '30,000 requests in the window produced ' + writes + ' writes');
});

test('users are throttled independently', function() {
  const t = createThrottle(1000);
  assert.strictEqual(t.take('a', 0), true);
  assert.strictEqual(t.take('b', 0), true);
  assert.strictEqual(t.take('a', 10), false);
});

test('it is bounded and evicts least-recent first', function() {
  const t = createThrottle(60000, 3);
  t.take('a', 0); t.take('b', 1); t.take('c', 2);
  assert.strictEqual(t.size(), 3);
  t.take('d', 3);
  assert.strictEqual(t.size(), 3, 'map grew past its cap');
  // 'a' was evicted, so it writes again; 'd' is still inside its window.
  assert.strictEqual(t.take('a', 4), true);
  assert.strictEqual(t.take('d', 5), false);
});

test('a missing key never writes', function() {
  const t = createThrottle(1000);
  [null, undefined, ''].forEach(k => assert.strictEqual(t.take(k, 0), false));
});
