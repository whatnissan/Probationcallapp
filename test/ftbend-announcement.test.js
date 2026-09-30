const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ftbend = require('../lib/ftbend');
const detection = require('../lib/detection');

// The five September mornings where Rosenberg 2 announced a colour, not
// phase groups. The per-user row was written 'P1:Gray P2:?' because the
// format followed the OFFICE; it now follows the announcement.
test('classify: a colour day at a phases office is a COLOUR', () => {
  assert.deepStrictEqual(ftbend.classifyAnswer('Gray'), { announced: ['gray'], phases: null });
  assert.strictEqual(ftbend.resultStringFor('Gray'), 'COLOR:Gray');
  assert.ok(!ftbend.resultStringFor('Gray').includes('?'), 'no question mark may ever be written again');
});

test('classify: a phase day is phases, with the word stripped', () => {
  assert.deepStrictEqual(ftbend.classifyAnswer('Phase 1, Phase 2'), { announced: null, phases: ['1', '2'] });
  assert.deepStrictEqual(ftbend.classifyAnswer('Phase 1 B, Phase 5'), { announced: null, phases: ['1 B', '5'] });
  assert.strictEqual(ftbend.resultStringFor('Phase 1, Phase 2'), 'P1:Phase 1 P2:Phase 2');
  assert.strictEqual(ftbend.resultStringFor(['Phase 1 b', 'Phase 3']), 'P1:Phase 1 b P2:Phase 3');
});

test('classify: one phase group is one segment, never a P2 placeholder', () => {
  assert.deepStrictEqual(ftbend.classifyAnswer('Phase 2'), { announced: null, phases: ['2'] });
  assert.strictEqual(ftbend.resultStringFor('Phase 2'), 'P1:Phase 2');
});

test('classify: a mixed colour-and-phase message stays one announced element (§4.11)', () => {
  const c = ftbend.classifyAnswer('Gray, Lemon, Prep, Phase 1, Phase 1 A, Phase 5');
  assert.strictEqual(c.phases, null);
  assert.strictEqual(c.announced.length, 1);
  assert.ok(c.announced[0].includes('phase 5'));
});

test('classify: Prep and Prep Phase N are announced values, not phase groups', () => {
  assert.deepStrictEqual(ftbend.classifyAnswer('Prep'), { announced: ['prep'], phases: null });
  assert.deepStrictEqual(ftbend.classifyAnswer('Prep Phase 1'), { announced: ['prep phase 1'], phases: null });
});

test('classify: nothing, empty and UNKNOWN are two nulls, not an empty array', () => {
  assert.deepStrictEqual(ftbend.classifyAnswer(null), { announced: null, phases: null });
  assert.deepStrictEqual(ftbend.classifyAnswer(''), { announced: null, phases: null });
  assert.deepStrictEqual(ftbend.classifyAnswer('UNKNOWN'), { announced: null, phases: null });
  assert.strictEqual(ftbend.resultStringFor('UNKNOWN'), 'UNKNOWN');
});

test('board: the colour leads, the unreliable phase columns are only a fallback', () => {
  // Five September rows have a colour and a NULL phase1_color, because
  // detection lacked Nickel/Iron and heard "Ping" for Pink.
  assert.deepStrictEqual(
    ftbend.announcementOf({ color: 'Nickel', phase1_color: null, phase2_color: null }),
    { announced: ['nickel'], phases: null });
  // Colour missing entirely: fall back to whatever the phase columns hold.
  assert.deepStrictEqual(
    ftbend.announcementOf({ color: null, phase1_color: 'Phase 1', phase2_color: 'Phase 3' }),
    { announced: null, phases: ['1', '3'] });
  assert.deepStrictEqual(
    ftbend.announcementOf({ color: 'UNKNOWN', phase1_color: null, phase2_color: null }),
    { announced: null, phases: null });
});

// The legacy string parser, for the year of rows written before migration 062.
test('legacy parser: a phase day yields both groups, not an empty list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = /function v1ParseAnnouncement[\s\S]*?\n}\n/.exec(src);
  assert.ok(m, 'v1ParseAnnouncement should still exist for legacy rows');
  const v1ParseAnnouncement = eval('(' + m[0].replace(/^function /, 'function ') + ')');
  assert.deepStrictEqual(v1ParseAnnouncement('P1:Phase 1 b P2:Phase 3'), { colors: null, phases: ['1 b', '3'] });
  assert.deepStrictEqual(v1ParseAnnouncement('P1:Phase 1 P2:Phase 2'), { colors: null, phases: ['1', '2'] });
  // The five bad September rows: the placeholder is dropped, never rendered.
  assert.deepStrictEqual(v1ParseAnnouncement('P1:Gray P2:?'), { colors: null, phases: ['Gray'] });
  assert.deepStrictEqual(v1ParseAnnouncement('COLOR:Nickel'), { colors: ['Nickel'], phases: null });
  assert.strictEqual(v1ParseAnnouncement('MUST_TEST'), null);
});

// The vocabulary comes from the catalogue, and the built-in list is a floor.
test('vocabulary: catalogue colours become detectable, built-ins survive', () => {
  assert.strictEqual(detection.detectColor('Today is Nickel.'), null, 'baseline: not in the built-in list');
  const info = detection.setColorVocabulary({ colors: ['nickel', 'iron', 'zinc', 'gray'], aliases: { ping: 'pink' } });
  assert.ok(info.colorsAdded >= 3);
  assert.strictEqual(detection.detectColor('Today is Nickel.'), 'Nickel');
  assert.strictEqual(detection.detectColor('Today is Iron.'), 'Iron');
  assert.strictEqual(detection.detectColor('Today is Ping.'), 'Pink', 'the alias the Sep 17 miss needed');
  assert.strictEqual(detection.detectColor('Today is Teal.'), 'Teal', 'a built-in the catalogue lacks must still resolve');
  assert.ok(info.codeOnly.includes('teal'), 'and the drift is reported so the catalogue can be completed');
});

test('vocabulary: a failed catalogue read leaves detection no worse', () => {
  detection.setColorVocabulary({ colors: [], aliases: {} });
  assert.strictEqual(detection.detectColor('Today is Gray.'), 'Gray');
  assert.strictEqual(detection.detectColor('Today is Teal.'), 'Teal');
});
