const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'redeem.html'), 'utf8');
const script = html.slice(html.indexOf('<script>\n') + 9, html.lastIndexOf('</script>'));

// Runs the page's real script against a minimal DOM, a fake Supabase
// session and a fake fetch. No browser needed; what it checks is the page's
// own logic: what is shown, what is sent, and when.

function el(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', href: '', disabled: false, children: [], handlers: {},
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild(c) { this.children.push(c); },
    addEventListener(ev, fn) { this.handlers[ev] = fn; }
  };
}

function load({ query, session, respond }) {
  const ids = ['code', 'redeemBtn', 'signInBtn', 'status', 'who', 'whoText', 'switchLink', 'form', 'done'];
  const els = {}; ids.forEach((i) => { els[i] = el(i); });
  ['signInBtn', 'who', 'done'].forEach((i) => els[i].classList.add('hidden'));
  els.redeemBtn.disabled = true;
  const sent = [];
  const ctx = vm.createContext({
    window: { location: { search: query || '' }, supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }) } },
    document: { getElementById: (i) => els[i], createElement: () => el('note') },
    URLSearchParams, encodeURIComponent, String, Number, JSON, console,
    fetch: async (url, opts) => { sent.push({ url, opts }); return respond(); }
  });
  vm.runInContext(script, ctx);
  return { els, sent, settle: () => new Promise((r) => setImmediate(r)) };
}
const SESSION = { access_token: 'tok-123', user: { email: 'person@example.invalid' } };
const reply = (status, body) => () => ({ ok: status < 300, status, json: async () => body });

test('signed out: the code is prefilled and sign-in brings them back to it', async () => {
  const p = load({ query: '?code=welcome25', session: null, respond: reply(200, {}) });
  await p.settle();
  assert.strictEqual(p.els.code.value, 'WELCOME25');
  assert.ok(!p.els.signInBtn.classList.contains('hidden'));
  assert.strictEqual(p.els.signInBtn.href, '/login?next=' + encodeURIComponent('/redeem?code=WELCOME25'));
  assert.strictEqual(p.sent.length, 0, 'nothing is redeemed by loading the page');
});

test('signed in: one tap redeems through /api/v1/redeem and says what happened', async () => {
  const p = load({ query: '?code=WELCOME25', session: SESSION, respond: reply(200, { credits: 10, attribution: { state: 'not_attributed', message: 'Credits added. The referral could not be credited — that code is not linked to an active account.' } }) });
  await p.settle();
  assert.strictEqual(p.sent.length, 0, 'still nothing before the tap');
  assert.strictEqual(p.els.redeemBtn.disabled, false);
  assert.match(p.els.whoText.textContent, /person@example\.invalid/);
  await p.els.redeemBtn.handlers.click();
  assert.strictEqual(p.sent.length, 1);
  assert.strictEqual(p.sent[0].url, '/api/v1/redeem');
  assert.strictEqual(p.sent[0].opts.headers.Authorization, 'Bearer tok-123');
  assert.deepStrictEqual(JSON.parse(p.sent[0].opts.body), { code: 'WELCOME25' });
  assert.strictEqual(p.els.status.textContent, '✅ 10 credits added to your account.');
  assert.match(p.els.status.children[0].textContent, /referral could not be credited/);
  assert.ok(!p.els.done.classList.contains('hidden'), 'return-to-app shown');
});

test('the endpoint\'s own message is shown on a refusal, and on the rate limit', async () => {
  const used = load({ query: '?code=WELCOME25', session: SESSION, respond: reply(400, { error: { code: 'promo_already_used', message: 'You have already used that code.' } }) });
  await used.settle(); await used.els.redeemBtn.handlers.click();
  assert.strictEqual(used.els.status.textContent, 'You have already used that code.');
  assert.strictEqual(used.els.redeemBtn.disabled, false, 'can try another code');
  const limited = load({ query: '?code=WELCOME25', session: SESSION, respond: reply(429, { error: 'Too many requests. Try again in 3200s.' }) });
  await limited.settle(); await limited.els.redeemBtn.handlers.click();
  assert.strictEqual(limited.els.status.textContent, 'Too many requests. Try again in 3200s.');
});

test('a hostile ?code= is not prefilled and cannot reach a link', async () => {
  const p = load({ query: '?code=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', session: null, respond: reply(200, {}) });
  await p.settle();
  assert.strictEqual(p.els.code.value, '');
  assert.strictEqual(p.els.signInBtn.href, '/login?next=' + encodeURIComponent('/redeem'));
});

test('a malformed code is refused before any request', async () => {
  const p = load({ query: '', session: SESSION, respond: reply(200, {}) });
  await p.settle();
  p.els.code.value = 'ab';
  await p.els.redeemBtn.handlers.click();
  assert.strictEqual(p.sent.length, 0);
  assert.strictEqual(p.els.status.textContent, 'Enter the code exactly as it was given to you.');
});
