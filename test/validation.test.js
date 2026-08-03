const test = require('node:test');
const assert = require('node:assert');

const { isValidPin, isValidTimezone, isValidEmail, normalizePhoneE164 } = require('../lib/validation');

test('isValidPin: exactly 6 digits', function() {
  assert.strictEqual(isValidPin('123456'), true);
  assert.strictEqual(isValidPin('000000'), true);
  assert.strictEqual(isValidPin('12345'), false);   // too short
  assert.strictEqual(isValidPin('1234567'), false); // too long
  assert.strictEqual(isValidPin('12345a'), false);  // non-digit
  assert.strictEqual(isValidPin(''), false);
  assert.strictEqual(isValidPin(null), false);
  assert.strictEqual(isValidPin(123456), false);    // must be a string
});

test('isValidPin: rejects the XSS payload shape that motivated this', function() {
  assert.strictEqual(isValidPin("'><img src=x onerror=alert(1)>"), false);
  assert.strictEqual(isValidPin('123456<script>'), false);
});

test('isValidTimezone: whitelist only', function() {
  assert.strictEqual(isValidTimezone('America/Chicago'), true);
  assert.strictEqual(isValidTimezone('America/New_York'), true);
  assert.strictEqual(isValidTimezone('Pacific/Honolulu'), true);
  assert.strictEqual(isValidTimezone('Europe/London'), false); // real IANA, not allowed
  assert.strictEqual(isValidTimezone('america/chicago'), false); // case-sensitive
  assert.strictEqual(isValidTimezone('Not/AZone'), false);
  assert.strictEqual(isValidTimezone(''), false);
  assert.strictEqual(isValidTimezone(null), false);
});

test('isValidEmail: accepts ordinary addresses', function() {
  assert.strictEqual(isValidEmail('a@b.co'), true);
  assert.strictEqual(isValidEmail('first.last+tag@sub.example.com'), true);
});

test('isValidEmail: rejects injection and malformed shapes', function() {
  assert.strictEqual(isValidEmail('a@b'), false);              // no TLD
  assert.strictEqual(isValidEmail('no-at-sign.com'), false);
  assert.strictEqual(isValidEmail('a@@b.com'), false);
  assert.strictEqual(isValidEmail('a b@c.com'), false);        // whitespace
  assert.strictEqual(isValidEmail('"><script>@x.com'), false); // quotes/brackets
  assert.strictEqual(isValidEmail('a@b.com\nBcc: x@y.com'), false); // header injection
  assert.strictEqual(isValidEmail('x'.repeat(250) + '@b.com'), false); // length cap
  assert.strictEqual(isValidEmail(null), false);
});

test('normalizePhoneE164: normalizes US 10- and 11-digit input', function() {
  assert.strictEqual(normalizePhoneE164('8778847310'), '+18778847310');
  assert.strictEqual(normalizePhoneE164('18778847310'), '+18778847310');
  assert.strictEqual(normalizePhoneE164('+1 (877) 884-7310'), '+18778847310');
  assert.strictEqual(normalizePhoneE164('877.884.7310'), '+18778847310');
});

test('normalizePhoneE164: returns null on anything it cannot normalize', function() {
  assert.strictEqual(normalizePhoneE164('12345'), null);
  assert.strictEqual(normalizePhoneE164('+44 20 7946 0958'), null); // non-US
  assert.strictEqual(normalizePhoneE164('not a phone'), null);
  assert.strictEqual(normalizePhoneE164(''), null);
  assert.strictEqual(normalizePhoneE164(null), null);
  assert.strictEqual(normalizePhoneE164(undefined), null);
});
