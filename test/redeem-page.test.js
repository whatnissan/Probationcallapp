const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'redeem.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');

// 2026-10-12: /redeem?code=<CODE> is the signed-in web page the app opens in
// Safari (App Store 3.1.1). It redeems through the app's own endpoint, so
// the rules and the affiliate attribution are identical.

test('GET /redeem serves the page', () => {
  assert.match(server, /app\.get\('\/redeem', function\(req, res\) \{ res\.sendFile\(path\.join\(__dirname, 'public', 'redeem\.html'\)\); \}\);/);
});

test('it redeems through POST /api/v1/redeem with the signed-in session, and nothing else', () => {
  assert.match(page, /fetch\('\/api\/v1\/redeem', \{/);
  assert.match(page, /'Authorization': 'Bearer ' \+ session\.access_token/);
  assert.ok(!/\/api\/redeem['"]/.test(page), 'not the legacy endpoint, which has no attribution');
});

test('only an explicit tap redeems — never page load', () => {
  const script = page.slice(page.indexOf('<script>\n'));
  const fetchAt = script.indexOf("fetch('/api/v1/redeem'");
  const clickAt = script.indexOf("redeemBtn.addEventListener('click'");
  assert.ok(clickAt > 0 && fetchAt > clickAt, 'the only fetch is inside the click handler');
  assert.strictEqual((script.match(/fetch\(/g) || []).length, 1);
});

test('the code from the URL never reaches the page as HTML', () => {
  const code = page.replace(/\/\/.*$/gm, '');   // comments may name the sinks they avoid
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code));
  assert.match(page, /var CODE_RE = \/\^\[A-Z0-9\]\{4,24\}\$\/;/, 'same shape the endpoint accepts');
  assert.match(page, /if \(CODE_RE\.test\(fromLink\)\) input\.value = fromLink;/);
  assert.match(page, /href="probationcall:\/\/return\?to=credits"/, 'back to the app through the existing return route');
});

// Pull safeAfterLogin out of login.html and run it.
function loginFn() {
  const start = login.indexOf('function safeAfterLogin(');
  let depth = 0, end = -1;
  for (let i = login.indexOf('{', start); i < login.length; i++) {
    if (login[i] === '{') depth++;
    else if (login[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const ctx = vm.createContext({});
  vm.runInContext(login.slice(start, end), ctx);
  return ctx.safeAfterLogin;
}

test('login returns to /redeem only — no open redirect', () => {
  const safe = loginFn();
  assert.strictEqual(safe('/redeem?code=WELCOME25'), '/redeem?code=WELCOME25');
  assert.strictEqual(safe('/redeem'), '/redeem');
  for (const bad of ['https://evil.example', '//evil.example', '/redeem?code=X1', '/redeem?code=ABC123&next=//evil', '/redeem?code=<script>', 'javascript:alert(1)', '/dashboard', '/redeem/../admin', '', null, undefined, '/Redeem?code=ABCD']) {
    assert.strictEqual(safe(bad), null, 'refused: ' + bad);
  }
});

test('every post-login redirect goes through the allowlist', () => {
  assert.ok(!/window\.location\.href = '\/dashboard';/.test(login), 'no direct dashboard redirect left');
  assert.strictEqual((login.match(/goAfterLogin\(\);/g) || []).length, 4);
  assert.match(login, /window\.location\.href = dest \|\| '\/dashboard';/);
});
