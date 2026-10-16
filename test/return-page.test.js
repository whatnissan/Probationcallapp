const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const r = require('../lib/return-page');
const template = fs.readFileSync(path.join(__dirname, '..', 'public', 'return.html'), 'utf8');
const hrefOf = (html) => (html.match(/id="open" href="([^"]*)"/) || [])[1];

test('the three real destinations resolve', function() {
  assert.strictEqual(r.resolveDestination('credits'), 'credits');
  assert.strictEqual(r.resolveDestination('subscription'), 'subscription');
  assert.strictEqual(r.resolveDestination('connect'), 'connect');
});

test('anything else opens the app rather than being trusted', function() {
  // `to` comes off a URL. It is never concatenated, so a crafted link cannot
  // rewrite the button into an open redirect or a javascript: URL on a page
  // handed to someone immediately after they pay.
  ['javascript:alert(1)', 'https://evil.example', 'x" onload="alert(1)', '', null, undefined,
   '__proto__', 'constructor', 'toString'].forEach(function(bad) {
    assert.strictEqual(r.resolveDestination(bad), 'app', 'unsafe value leaked: ' + bad);
  });
});

test('the rendered button is a plain anchor to the app scheme, labelled Back to ProbationCall', function() {
  // It must work with no JavaScript, and it is the only way back: there is
  // no automatic redirect (see below).
  assert.strictEqual(hrefOf(r.renderReturnPage(template, 'credits')), 'probationcall://return?to=credits');
  assert.strictEqual(hrefOf(r.renderReturnPage(template, 'bogus')), 'probationcall://return?to=app');
  assert.strictEqual(hrefOf(r.renderReturnPage(template, { to: 'subscription', result: 'success', session_id: 'cs_live_' + 'a'.repeat(20) })),
    'probationcall://return?to=subscription', 'extra parameters never reach the app link');
  assert.match(r.renderReturnPage(template, 'connect'), /<a class="btn" id="open" href="probationcall:\/\/return\?to=connect">Back to ProbationCall<\/a>/);
});

test('no placeholder survives rendering', function() {
  const cases = ['credits', 'subscription', 'connect', 'bogus', undefined,
    { to: 'credits', result: 'success', session_id: 'cs_test_' + 'b'.repeat(20) },
    { to: 'credits', result: 'canceled' }, { to: 'subscription', from: 'portal' }];
  cases.forEach(function(t) {
    const html = r.renderReturnPage(template, t, { paid: true, kind: 'credits', credits: 30, granted: false });
    assert.ok(!/__[A-Z]+__/.test(html), JSON.stringify(t));
  });
});

test('no automatic redirect to the app scheme (2026-10-15)', function() {
  // Payment flows open in real Safari now. On a phone WITHOUT the app, a
  // scripted jump to probationcall:// shows "address is invalid" over the
  // page; WITH it, the system prompt covers what the page says. The button
  // is the way back.
  const html = r.renderReturnPage(template, { to: 'credits', result: 'success', session_id: 'cs_live_' + 'c'.repeat(20) },
    { paid: true, kind: 'credits', credits: 30, granted: true });
  assert.ok(!/<script/i.test(html), 'no script at all');
  assert.ok(!/http-equiv="refresh"[^>]*probationcall:/i.test(html));
});

test('the page warns about the iOS "Open in..." prompt, and makes sense without the app', function() {
  const html = r.renderReturnPage(template, 'credits');
  assert.match(html, /Tap <b>Open<\/b> when your phone asks\./);
  assert.match(html, /No app on this device\? <a href="\/login">Sign in on the website<\/a>/);
});

const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const SID = 'cs_live_' + 'd'.repeat(24);

test('a payment is claimed only from verified facts', function() {
  // Stripe sends people here the moment they finish, which can be before the
  // webhook has granted anything. Without facts, nothing is claimed.
  [undefined, null].forEach(function(facts) {
    const text = visible(r.renderReturnPage(template, { to: 'credits', result: 'success', session_id: SID }, facts));
    assert.ok(!/(payment|purchase|order)\s*(is)?\s*(complete|successful|confirmed|received)/i.test(text), text);
    assert.ok(!/credits? (added|granted|applied)/i.test(text), text);
    assert.match(text, /If your payment went through, your credits will show in the app shortly\./);
  });
  // An old-style link with no session id is the same.
  assert.match(visible(r.renderReturnPage(template, 'subscription')), /If your payment went through/);
});

test('credits: "N credits added" once the ledger has them, "being added" before', function() {
  const q = { to: 'credits', result: 'success', session_id: SID };
  const done = r.renderReturnPage(template, q, { paid: true, kind: 'credits', credits: 30, granted: true });
  assert.match(visible(done), /30 credits added Your payment went through and the credits are on your account\./);
  assert.match(done, /<title>30 credits added - ProbationCall<\/title>/);
  assert.ok(!/http-equiv="refresh"/.test(done), 'nothing left to wait for');
  const pending = r.renderReturnPage(template, q, { paid: true, kind: 'credits', credits: 30, granted: false });
  assert.match(visible(pending), /Payment received Your 30 credits are being added\. They will show in the app within a minute\./);
  assert.match(pending, /<meta http-equiv="refresh" content="5;url=\/return\?to=credits&amp;result=success&amp;session_id=cs_live_d+&amp;again=1">/,
    'one reload to catch the grant');
  const again = r.renderReturnPage(template, Object.assign({ again: '1' }, q), { paid: true, kind: 'credits', credits: 30, granted: false });
  assert.ok(!/http-equiv="refresh"/.test(again), 'and only one');
  assert.match(visible(r.renderReturnPage(template, q, { paid: true, kind: 'credits', credits: 1, granted: true })), /1 credit added Your payment went through and the credit is on your account\./);
});

test('subscription: says it started, and the 31 credits once they land', function() {
  const q = { to: 'subscription', result: 'success', session_id: SID };
  assert.match(visible(r.renderReturnPage(template, q, { paid: true, kind: 'subscription', credits: 31, granted: true })),
    /Subscription started — 31 credits added You get 31 credits every month it renews\. You can cancel any time from the app\./);
  assert.match(visible(r.renderReturnPage(template, q, { paid: true, kind: 'subscription', credits: 31, granted: false })),
    /Subscription started Your first 31 credits are being added\./);
});

test('unpaid, canceled and portal returns each say what is true', function() {
  assert.match(visible(r.renderReturnPage(template, { to: 'credits', result: 'success', session_id: SID }, { paid: false, kind: 'credits', credits: 30, granted: false })),
    /Payment not finished Stripe has not confirmed this payment, and nothing has been added\./);
  const canceled = visible(r.renderReturnPage(template, { to: 'credits', result: 'canceled' }));
  assert.match(canceled, /Checkout canceled Nothing was charged\./);
  assert.match(visible(r.renderReturnPage(template, { to: 'subscription', from: 'portal' })),
    /Subscription settings closed Any change you made is saved with Stripe\. The app shows your current plan\./);
});

test('nothing from the URL is echoed: bad session ids and values are dropped', function() {
  ['cs_live_short', 'cs_live_' + 'e'.repeat(20) + '"><script>', 'pi_123', 'cs_live_' + 'f'.repeat(20) + '&x=1', ['cs_live_' + 'g'.repeat(20)]]
    .forEach(function(bad) { assert.strictEqual(r.parseReturnQuery({ session_id: bad }).sessionId, null, String(bad)); });
  assert.strictEqual(r.parseReturnQuery({ result: 'constructor' }).result, null);
  assert.strictEqual(r.parseReturnQuery({ from: '__proto__' }).from, null);
  const html = r.renderReturnPage(template, { to: '<b>x</b>', result: '"><img>', from: 'x', session_id: '<svg>' });
  assert.ok(!/<b>x<\/b>|<img>|<svg>/.test(html));
});

test('every app payment flow returns to /return with what happened in the URL', function() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const to of ['subscription', 'credits']) {
    assert.ok(server.includes("success_url: process.env.BASE_URL + '/return?to=" + to + "&result=success&session_id={CHECKOUT_SESSION_ID}'"), to + ' success');
    assert.ok(server.includes("cancel_url: process.env.BASE_URL + '/return?to=" + to + "&result=canceled'"), to + ' cancel');
  }
  assert.ok(server.includes("billing.openBillingPortal(profile, process.env.BASE_URL + '/return?to=subscription&from=portal')"), 'portal');
  const route = server.slice(server.indexOf("app.get('/return'"), server.indexOf("app.get('/privacy'"));
  assert.match(route, /if \(q\.result === 'success' && q\.sessionId && returnLookupAllowed\(req\.ip\)\)/, 'Stripe is asked only for a well-formed session, within the limit');
  assert.ok(!/status\(429\)/.test(route), 'the page never turns into a 429 body');
});
