const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ftbend = require('../lib/ftbend');
const { formatLocalDay } = require('../lib/time');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-02: a Fort Bend schedule created after its office's answer was
// confirmed gets today's verdict at once — free, in-app only, idempotent, and
// only from an answer our own call confirmed.

const DATE = '2026-10-02';
const REC = 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE' + 'c'.repeat(32) + '.mp3';
const row = (extra) => Object.assign({
  county: 'ftbend_rosenberg2', date: DATE, color: 'Gray', phase1_color: 'Gray', phase2_color: null,
  transcript: 'The color for today is gray.', recording_url: REC, recording_duration_seconds: 26
}, extra || {});

test('the colours compared against are the morning fan-out\'s', () => {
  assert.deepStrictEqual(ftbend.todayColorsFor('Gray', 'Gray', null), ['gray']);
  assert.deepStrictEqual(ftbend.todayColorsFor('Phase 1 B, Phase 3', '1 B', '3'), ['1 b', '3']);
  assert.deepStrictEqual(ftbend.todayColorsFor('Lemon', null, null), ['lemon'], 'the answer itself when no groups');
  assert.deepStrictEqual(ftbend.todayColorsFor('UNKNOWN', null, null), []);
  assert.deepStrictEqual(ftbend.todayColorsFor('PHASES', null, null), []);
});

test('one verdict rule', () => {
  assert.strictEqual(ftbend.verdictFor('gray', ['gray'], false), 'MUST_TEST');
  assert.strictEqual(ftbend.verdictFor('Gray', ['gray'], false), 'MUST_TEST', 'case does not matter');
  assert.strictEqual(ftbend.verdictFor('lemon', ['gray'], false), 'NO_TEST');
  assert.strictEqual(ftbend.verdictFor(null, ['gray'], false), 'NO_COLOR');
  assert.strictEqual(ftbend.verdictFor('gray', ['gray'], true), 'UNKNOWN');
});

test('a signup-day answer comes only from a confirmed answer of our own call', () => {
  const a = ftbend.signupDayAnswer(row(), 'rosenberg2', DATE);
  assert.ok(a, 'confirmed: answered');
  assert.strictEqual(a.result, 'Gray');
  assert.deepStrictEqual(a.todayColors, ['gray']);
  assert.strictEqual(a.recording.recording_url, REC, "with the office's own recording");
  assert.strictEqual(a.recording.transcript, 'The color for today is gray.');

  assert.strictEqual(ftbend.signupDayAnswer(null, 'rosenberg2', DATE), null, 'nothing confirmed yet');
  assert.strictEqual(ftbend.signupDayAnswer(row({ recording_url: null }), 'rosenberg2', DATE), null,
    'resolved from finishprobation.com: not confirmed by us');
  assert.strictEqual(ftbend.signupDayAnswer(row({ color: 'UNKNOWN', phase1_color: null }), 'rosenberg2', DATE), null, 'never from UNKNOWN');
  assert.strictEqual(ftbend.signupDayAnswer(row(), 'missouri', DATE), null, "never another office's answer");
  assert.strictEqual(ftbend.signupDayAnswer(row({ date: '2026-10-01' }), 'rosenberg2', DATE), null, "never another day's");
});

test('the window closes at UTC midnight, so a row can never read as tomorrow\'s', () => {
  const at = (iso) => { const d = new Date(iso); return ftbend.signupDayWindowOpen(d, formatLocalDay(d, 'America/Chicago')); };
  assert.strictEqual(at('2026-10-02T11:00:00Z'), true, '6 AM CDT');
  assert.strictEqual(at('2026-10-02T23:59:00Z'), true, '6:59 PM CDT');
  assert.strictEqual(at('2026-10-03T00:00:00Z'), false, '7:00 PM CDT — still Oct 2 in Texas, Oct 3 in UTC');
  assert.strictEqual(at('2026-10-03T04:59:00Z'), false, '11:59 PM CDT');
  assert.strictEqual(at('2026-10-03T05:00:00Z'), true, 'midnight CDT — both Oct 3');
  assert.strictEqual(at('2026-12-02T23:59:00Z'), true, '5:59 PM CST — both Dec 2');
  assert.strictEqual(at('2026-12-03T00:00:00Z'), false, '6:00 PM CST in winter');
});

function fnBody(name, len) {
  const i = server.indexOf('async function ' + name + '(');
  assert.ok(i > 0, name + ' should exist');
  return server.slice(i, i + len).replace(/\/\/.*$/gm, '');
}

test('the writer is free, in-app only, marked, and idempotent', () => {
  const fn = fnBody('writeFtbendSignupDayVerdict', 5200);
  assert.ok(!/\bnotify\(|sendSMS\(|sendEmail\(|tryPushFirst\(/.test(fn), 'no SMS, email or push');
  assert.ok(!/deductCreditOnce|billed_at:/.test(fn), 'never billed');
  assert.match(fn, /origin: 'signup_day'/);
  assert.match(fn, /ftbend\.signupDayAnswer\(dcs\.data, oid, todayDate\)/);
  assert.match(fn, /ftbend\.signupDayWindowOpen\(now, todayDate\)/);
  assert.match(fn, /ftbend\.verdictFor\(userColor, answer\.todayColors, false\)/);
  // The same per-user/office/day check the morning delivery uses.
  const dedupe = /\.from\('call_history'\)\s*\.select\('id'\)\s*\.eq\('user_id', userId\)\s*\.eq\('county', 'ftbend'\)\s*\.eq\('ftbend_office', oid\)\s*\.gte\('created_at', todayDate \+ 'T00:00:00'\)\s*\.lte\('created_at', todayDate \+ 'T23:59:59'\)/;
  assert.match(fn, dedupe, 'signup day checks before writing');
  assert.match(fnBody('deliverFtbendNotification', 900), dedupe, 'and the morning run checks the same way, so it skips a day already answered');
});

test('both writers call it on FIRST creation only', () => {
  assert.match(server, /if \(!existing\.data\) await writeFtbendSignupDayVerdict\(req\.user\.id, data\);/, 'app PUT');
  assert.match(server, /if \(!existingResult\.data\) await writeFtbendSignupDayVerdict\(req\.user\.id, data\);/, 'website POST');
});

test('the morning run uses the same shared rules', () => {
  assert.match(server, /var todayColors = ftbend\.todayColorsFor\(config\.result, config\.phase1, config\.phase2\);/);
  assert.match(server, /var ftVerdict = ftbend\.verdictFor\(userColor, todayColors, isUnknown\);/);
});

test('a free signup-day row is not counted as a billing failure', () => {
  assert.match(server, /billable_unbilled: billable\.filter\(function\(c\) \{ return !c\.billed_at && c\.origin !== 'signup_day'; \}\)\.length/);
  assert.match(server, /from\('call_history'\)\.select\('result, billed_at, created_at, origin'\)/);
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '066_call_history_origin.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS origin text/);
  assert.match(sql, /INSERT INTO schema_migrations/);
});
