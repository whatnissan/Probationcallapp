const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { officeRecordingFor } = require('../lib/ftbend');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-01: every Fort Bend subscriber's row carries the recording of THEIR
// office's call for THAT date. A wrong-office recording on a result screen is
// worse than none, so the copy is refused unless office and date both match.

const DATE = '2026-10-01';
const office = (id, extra) => Object.assign({
  county: 'ftbend_' + id, date: DATE,
  transcript: id + ' office transcript',
  recording_url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE' + id.padEnd(32, '0').slice(0, 32) + '.mp3',
  recording_duration_seconds: 21
}, extra || {});

test("a subscriber's row gets their own office's recording and transcript, together", () => {
  const copy = officeRecordingFor(office('rosenberg2'), 'rosenberg2', DATE);
  assert.deepStrictEqual(copy, {
    recording_url: office('rosenberg2').recording_url,
    recording_duration_seconds: 21,
    transcript: 'rosenberg2 office transcript'
  });
});

test("another office's row is refused — audio and transcript both", () => {
  for (const [rowOffice, subscriberOffice] of [['rosenberg', 'missouri'], ['missouri', 'rosenberg'], ['rosenberg', 'rosenberg2'], ['rosenberg2', 'rosenberg']]) {
    assert.strictEqual(officeRecordingFor(office(rowOffice), subscriberOffice, DATE), null,
      rowOffice + ' audio must never reach a ' + subscriberOffice + ' subscriber');
  }
});

test("another date's row is refused", () => {
  assert.strictEqual(officeRecordingFor(office('missouri', { date: '2026-09-30' }), 'missouri', DATE), null);
});

test('no call of our own (finishprobation.com) copies nothing — not even the transcript', () => {
  const fp = office('missouri', { recording_url: null, transcript: 'text from finishprobation.com' });
  assert.strictEqual(officeRecordingFor(fp, 'missouri', DATE), null);
});

test('missing or unknown inputs copy nothing', () => {
  assert.strictEqual(officeRecordingFor(null, 'missouri', DATE), null);
  assert.strictEqual(officeRecordingFor(office('missouri'), null, DATE), null);
  assert.strictEqual(officeRecordingFor(office('missouri'), 'missouri', null), null);
  assert.strictEqual(officeRecordingFor(office('ftbend_undefined'.replace('ftbend_', '')), 'undefined', DATE), null, 'not one of the three offices');
  assert.strictEqual(officeRecordingFor(office('missouri', { recording_duration_seconds: null }), 'missouri', DATE).recording_duration_seconds, null);
});

// ---- wiring in server.js ----

function slice(marker, len) {
  const i = server.indexOf(marker);
  assert.ok(i > 0, marker + ' should be findable');
  return server.slice(i, i + len);
}
const code = (s) => s.replace(/\/\/.*$/gm, '');

test('the recording is no longer attached before the office row exists', () => {
  const pr = code(slice('async function processRecording(', 2500));
  assert.ok(!/from\('daily_county_status'\)/.test(pr), 'processRecording does not write the office row up front');
  assert.match(pr, /if \(!config\.isFtbendDaily && config\.callSid\)/, 'the early attach is Montgomery only');
});

test('a Fort Bend recording with no known office is not filed under Missouri City', () => {
  assert.ok(!/config\.officeId \|\| 'missouri'/.test(code(server)), "no `config.officeId || 'missouri'` fallback anywhere");
  const branch = code(slice('// Fort Bend - detect color and phases', 1600));
  assert.match(branch, /var officeId = config\.officeId;\s+if \(!FTBEND_OFFICES\[officeId\]\) \{[\s\S]*?return;/);
});

test('only the confirmed path stores a recording; every finishprobation path stores none', () => {
  // Each call's argument list, up to its closing `);`.
  const sites = code(server).split('storeFtbendColor(').slice(1)
    .map((c) => c.slice(0, c.indexOf(');')))
    .filter((args) => !/^color, transcript, officeId/.test(args));   // drop the definition
  assert.strictEqual(sites.length, 4, 'four call sites');
  const withRecording = sites.filter((a) => /\{ url: mp3Url, durationSeconds: recordingDurationSeconds \}$/.test(a));
  const withNull = sites.filter((a) => /,\s*null$/.test(a));
  assert.strictEqual(withRecording.length, 1, 'exactly one: the confirmed call');
  assert.ok(/^crossCheck\.final_answer, transcript, officeId/.test(withRecording[0]), 'and it is the confirmed branch');
  assert.strictEqual(withNull.length, 3, 'cutoff, poller cutoff and the populate path pass null');
});

test('the office row writes URL, duration and transcript in one write', () => {
  const fn = code(slice('async function storeFtbendColor(', 1800));
  assert.match(fn, /transcript: transcript,/);
  assert.match(fn, /recording_url: recording && recording\.url \? recording\.url : null,/);
  assert.match(fn, /recording_duration_seconds: recording && typeof recording\.durationSeconds === 'number'/);
});

test("delivery copies the office recording only through the office check", () => {
  const fn = code(slice('async function deliverFtbendNotification(', 14000));
  assert.match(fn, /ftRec = ftbend\.officeRecordingFor\(dcs\.data, oid, todayDate\);/);
  assert.match(fn, /recording_url: ftRec \? ftRec\.recording_url : null,/);
  assert.match(fn, /transcript: ftRec \? ftRec\.transcript : null,/);
  assert.ok(!/dcs\.data\.transcript\b(?!\s*\?)/.test(fn.replace(/console\.log\([^;]*\);/g, '')), 'no direct transcript copy around the check');
});

test('the 30-day deletion covers office rows and stamps what it clears', () => {
  const sweep = code(slice('async function deleteExpiredRecordings(table)', 3200));
  assert.match(sweep, /\.update\(\{ recording_url: null, recording_deleted_at: new Date\(\)\.toISOString\(\) \}\)/);
  const cron = slice("cron.schedule('0 3 * * *'", 300);
  assert.match(cron, /deleteExpiredRecordings\('call_history'\)/);
  assert.match(cron, /deleteExpiredRecordings\('daily_county_status'\)/);
});
