const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const terms = require('../lib/terms');

// THE PIN. The Terms page and the version constant drifted once: the
// 2026-08-24 edit changed the text and left "Last Updated: December 4, 2025"
// on the page. An acceptance recorded against a version the page does not
// show is not a record anyone can rely on. If this fails, the page text was
// edited without its date, or the date without CURRENT_VERSION — fix both
// together, and move REQUIRED_VERSION too if the edit was material.
test('pin: CURRENT_VERSION equals the Last Updated date on public/terms.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'terms.html'), 'utf8');
  const onPage = terms.lastUpdatedFromTermsHtml(html);
  assert.ok(onPage, 'terms.html must carry a "Last Updated: Month D, YYYY" date');
  assert.strictEqual(onPage, terms.CURRENT_VERSION,
    'terms.html says Last Updated ' + onPage + ' but lib/terms.js CURRENT_VERSION is ' + terms.CURRENT_VERSION);
});

test('versions: required is never newer than current, both well-formed and in history', () => {
  assert.ok(terms.isVersionString(terms.CURRENT_VERSION));
  assert.ok(terms.isVersionString(terms.REQUIRED_VERSION));
  assert.ok(terms.REQUIRED_VERSION <= terms.CURRENT_VERSION);
  const known = terms.VERSION_HISTORY.map(v => v.version);
  assert.ok(known.includes(terms.CURRENT_VERSION));
  assert.ok(known.includes(terms.REQUIRED_VERSION));
});

test('version strings: real calendar dates only', () => {
  assert.ok(terms.isVersionString('2026-08-24'));
  assert.ok(!terms.isVersionString('2026-02-30'));
  assert.ok(!terms.isVersionString('2026-8-24'));
  assert.ok(!terms.isVersionString(''));
  assert.ok(!terms.isVersionString(null));
  assert.ok(!terms.isVersionString(20260824));
});

test('needsAcceptance: none on file, or older than required', () => {
  assert.equal(terms.needsAcceptance(null, '2025-12-04'), true);
  assert.equal(terms.needsAcceptance('2025-12-04', '2025-12-04'), false);
  assert.equal(terms.needsAcceptance('2026-08-24', '2025-12-04'), false);
  assert.equal(terms.needsAcceptance('2025-12-04', '2026-08-24'), true);
});

test('payload: an account with no record needs acceptance and shows no date', () => {
  const p = terms.termsPayload(null);
  assert.deepEqual(p, {
    currentVersion: terms.CURRENT_VERSION, requiredVersion: terms.REQUIRED_VERSION,
    acceptedVersion: null, acceptedAt: null, needsAcceptance: true
  });
});

test('payload: an older website acceptance still counts under today\'s required version', () => {
  const p = terms.termsPayload({ terms_version: '2025-12-04', accepted_at: '2025-12-07T02:55:10Z' });
  assert.equal(p.acceptedVersion, '2025-12-04');
  assert.equal(p.acceptedAt, '2025-12-07T02:55:10Z');
  assert.equal(p.needsAcceptance, false);
});

test('page date parser: the forms the page uses, and garbage', () => {
  assert.equal(terms.lastUpdatedFromTermsHtml('<p>Effective Date: December 4, 2025 | Last Updated: August 24, 2026</p>'), '2026-08-24');
  assert.equal(terms.lastUpdatedFromTermsHtml('Last Updated: December 4, 2025'), '2025-12-04');
  assert.equal(terms.lastUpdatedFromTermsHtml('Last Updated: Smarch 4, 2025'), null);
  assert.equal(terms.lastUpdatedFromTermsHtml('Last Updated: February 30, 2026'), null);
  assert.equal(terms.lastUpdatedFromTermsHtml('no date here'), null);
});

// The admin panel reads the profile object the dashboard handler hands it,
// and that handler selects NAMED COLUMNS. A field the panel renders but the
// select omits is undefined in the UI — which reads as "no acceptance" for
// every account, indistinguishable from the real thing. Pin both terms
// columns to the select.
test('admin: the dashboard select carries both terms columns the panel renders', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = /\.select\('id, email, credits, referred_by[^']*'\)/.exec(server);
  assert.ok(m, 'the admin dashboard named-column select should still be findable');
  assert.match(m[0], /terms_accepted_at/);
  assert.match(m[0], /terms_version/);
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(admin, /function termsCell\(/, 'the panel renders the terms cell through termsCell');
  assert.match(admin, /u\.terms_version/, 'termsCell shows which document was accepted');
  assert.ok(!/badge yes'>Yes<\/span>":"<span class='badge no'>No/.test(admin),
    'the old bare Yes/No terms badge should be gone');
});
