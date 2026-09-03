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

test('the rendered button is a plain anchor to the app scheme', function() {
  // It must work with no JavaScript: inside SFSafariViewController the
  // automatic bounce is sometimes blocked, and the tap is the reliable path.
  assert.strictEqual(hrefOf(r.renderReturnPage(template, 'credits')), 'probationcall://return?to=credits');
  assert.strictEqual(hrefOf(r.renderReturnPage(template, 'bogus')), 'probationcall://return?to=app');
  assert.ok(/<a class="btn" id="open" href="probationcall:/.test(r.renderReturnPage(template, 'connect')));
});

test('no placeholder survives rendering', function() {
  ['credits', 'subscription', 'connect', 'bogus', undefined].forEach(function(t) {
    assert.ok(!r.renderReturnPage(template, t).includes('__DEST__'));
  });
});

test('the visible copy never claims the payment succeeded', function() {
  // Stripe sends people here the moment they finish, which can be before the
  // webhook has granted anything. A success claim here would be a guess.
  const text = r.renderReturnPage(template, 'credits')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  assert.ok(!/(payment|purchase|order)\s*(is)?\s*(complete|successful|confirmed|received)/i.test(text));
  assert.ok(!/credits? (added|granted|applied)/i.test(text));
});
