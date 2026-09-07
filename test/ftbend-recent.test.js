const test = require('node:test');
const assert = require('node:assert');
const ftbend = require('../lib/ftbend');

// Real row shapes from daily_county_status.
const row = (county, date, color, p1, p2) =>
  ({ county: county, date: date, color: color, phase1_color: p1, phase2_color: p2 });

test('announcement: a plain colour is announced, never phases', function() {
  assert.deepStrictEqual(ftbend.announcementOf(row('ftbend_missouri', '2026-09-06', 'Apricot', 'Apricot', null)),
    { announced: ['apricot'], phases: null });
  // Lowercased on the wire, matching §4.1's example.
  assert.deepStrictEqual(ftbend.announcementOf(row('x', 'd', 'GRAY', 'GRAY', null)).announced, ['gray']);
});

test('announcement: classified by the VALUE, not the office', function() {
  // Rosenberg 2 announcing a bare colour is a COLOUR, not phases — this is the
  // case that made the removed byDayOfWeek look significant on weekends.
  assert.deepStrictEqual(ftbend.announcementOf(row('ftbend_rosenberg2', '2026-09-05', 'Gray', 'Gray', null)),
    { announced: ['gray'], phases: null });
  // And Missouri City would report phases correctly if it ever announced them.
  assert.deepStrictEqual(ftbend.announcementOf(row('ftbend_missouri', 'd', 'Phase 1, Phase 3', 'Phase 1', 'Phase 3')),
    { announced: null, phases: ['1', '3'] });
});

test('announcement: the word "Phase" is stripped, the rest is not', function() {
  assert.deepStrictEqual(ftbend.announcementOf(row('x', 'd', 'Phase 1, Phase 1 B', 'Phase 1', 'Phase 1 B')).phases,
    ['1', '1 B']);
  assert.deepStrictEqual(ftbend.announcementOf(row('x', 'd', 'Phase 5', 'Phase 5', null)).phases, ['5']);
});

test('announcement: a combined colour-and-phase message stays ONE element', function() {
  // The §4.11 limitation, asserted so it cannot be "fixed" by splitting on
  // commas without the contract changing first: splitting would invent
  // colours the hotline never announced as separate items.
  var a = ftbend.announcementOf(row('ftbend_rosenberg2', '2026-08-30',
    'Gray, Lemon, Prep, Phase 1, Phase 1 A, Phase 1 B, Phase 2, Phase 3, Phase 4, Phase 5', 'Gray', 'Lemon'));
  assert.strictEqual(a.phases, null);           // phase1/phase2 read as colours
  assert.strictEqual(a.announced.length, 1);    // NOT ten
  assert.ok(a.announced[0].indexOf('phase 5') !== -1);
});

test('announcement: nothing heard is two nulls, not an empty array', function() {
  // An empty array would decode as "announced nothing", which is a different
  // claim from "we have no row".
  assert.deepStrictEqual(ftbend.announcementOf(null), { announced: null, phases: null });
  assert.deepStrictEqual(ftbend.announcementOf(row('x', 'd', null, null, null)), { announced: null, phases: null });
});

test('recent: newest first, offices in wire order', function() {
  var out = ftbend.groupRecent([
    row('ftbend_rosenberg2', '2026-09-04', 'Phase 1, Phase 1 B', 'Phase 1', 'Phase 1 B'),
    row('ftbend_missouri',   '2026-09-06', 'Apricot', 'Apricot', null),
    row('ftbend_rosenberg',  '2026-09-04', 'Copper', 'Copper', null),
    row('ftbend_missouri',   '2026-09-04', 'Copper', 'Copper', null)
  ]);
  assert.deepStrictEqual(out.map(function(d) { return d.date; }), ['2026-09-06', '2026-09-04']);
  assert.deepStrictEqual(out[1].offices.map(function(o) { return o.office; }),
    ['missouri', 'rosenberg', 'rosenberg2']);
  assert.deepStrictEqual(out[1].offices[2], { office: 'rosenberg2', announced: null, phases: ['1', '1 B'] });
});

test('recent: a missing office is OMITTED, not emitted as a null pair', function() {
  // §4.11: a missing office means we captured nothing that day. An entry with
  // both fields null would render as an announcement of nothing.
  var out = ftbend.groupRecent([row('ftbend_missouri', '2026-09-06', 'Apricot', 'Apricot', null)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].offices.length, 1);
  assert.strictEqual(out[0].offices[0].office, 'missouri');
});

test('recent: rows from unknown office keys are dropped', function() {
  // ftbend_undefined exists in the table (2 rows) and is not one of the three
  // offices the contract names.
  var out = ftbend.groupRecent([
    row('ftbend_undefined', '2026-09-06', 'Gray', 'Gray', null),
    row('ftbend', '2026-09-06', 'Gray', 'Gray', null),
    row('ftbend_missouri', '2026-09-06', 'Apricot', 'Apricot', null)
  ]);
  assert.strictEqual(out[0].offices.length, 1);
  assert.strictEqual(out[0].offices[0].office, 'missouri');
});

test('recent: empty and malformed input produce an empty array, never a throw', function() {
  assert.deepStrictEqual(ftbend.groupRecent([]), []);
  assert.deepStrictEqual(ftbend.groupRecent(null), []);
  assert.deepStrictEqual(ftbend.groupRecent([{}, { county: 'ftbend_missouri' }]), []);
});
