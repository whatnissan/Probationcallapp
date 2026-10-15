const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

// 2026-10-15: Apple is moving NEW Sign in with Apple relay addresses from
// @privaterelay.appleid.com to @private.icloud.com. The dashboard's two relay
// warnings matched only the old domain, so new relay users went unwarned.

function extract(name) {
  const start = dash.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should be in dashboard.html');
  let depth = 0;
  for (let i = dash.indexOf('{', start); i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}' && --depth === 0) return dash.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const ctx = vm.createContext({});
vm.runInContext(extract('isAppleRelayEmail'), ctx);
const relay = (e) => ctx.isAppleRelayEmail(e);

test('both relay domains count, in any case', () => {
  assert.strictEqual(relay('abc123@privaterelay.appleid.com'), true);
  assert.strictEqual(relay('abc123@private.icloud.com'), true);
  assert.strictEqual(relay('ABC123@Private.iCloud.com'), true);
  assert.strictEqual(relay(' abc123@private.icloud.com '), true, 'stray whitespace');
});

test('exact domains only — an ordinary iCloud mailbox is not a relay', () => {
  for (const e of ['person@icloud.com', 'person@me.com', 'person@mac.com', 'person@gmail.com',
    'x@sub.private.icloud.com', 'x@private.icloud.com.example.com', 'x@notprivate.icloud.com',
    'x@privaterelay.appleid.com.evil.test', 'private.icloud.com', '', null, undefined]) {
    assert.strictEqual(relay(e), false, String(e));
  }
});

test('both dashboard checks use it, and no check is left on the old domain alone', () => {
  assert.match(dash, /relayNote\.style\.display = isAppleRelayEmail\(d\.user\.email\) \? 'block' : 'none';/);
  assert.match(dash, /\} else if \(isAppleRelayEmail\(email\)\) \{\s*alt\.style\.display = 'block'; warn\.style\.display = 'block';/);
  const code = dash.replace(/\/\/.*$/gm, '');
  assert.strictEqual((code.match(/privaterelay/g) || []).length, 1, 'the domain appears once, in isAppleRelayEmail');
});
