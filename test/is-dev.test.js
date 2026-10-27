const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-27: isDev(null) threw, and its callers include the morning job,
// billing, Fort Bend delivery and missed-call recovery. Every profile having
// an email was a coincidence, not a guarantee. The real function, run here.
function load() {
  const start = server.indexOf('function isDev(email) {');
  const fn = server.slice(start, server.indexOf('\n}\n', start) + 2);
  const devLine = server.match(/const DEV_EMAILS = \[[^\]]*\];/)[0];
  const ctx = vm.createContext({});
  vm.runInContext(devLine.replace('const ', 'var ') + '\n' + fn, ctx);
  return ctx;
}

test('isDev never throws on a missing email', () => {
  const { isDev } = load();
  for (const v of [null, undefined, '']) assert.strictEqual(isDev(v), false, String(v));
});

test('isDev still recognises the dev accounts, in any case', () => {
  const { isDev, DEV_EMAILS } = load();
  assert.ok(DEV_EMAILS.length > 0);
  assert.strictEqual(isDev(DEV_EMAILS[0]), true);
  assert.strictEqual(isDev(DEV_EMAILS[0].toUpperCase()), true);
  assert.strictEqual(isDev('someone@example.invalid'), false);
});
