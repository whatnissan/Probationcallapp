const test = require('node:test');
const assert = require('node:assert');

const {
  detectColor, detectPhaseColors, doCrossCheck, normalizePhaseNumerals
} = require('../lib/detection');

// Real Rosenberg 2 transcripts pulled from fort_bend_learnings. Each of these
// was a LIVE failure: 2026-08-04 looped to attempt 9 against a byte-identical
// string because "phase five" was outside the vocabulary. These are the
// regression net — if the phase list or the numeral map is trimmed again,
// these fail rather than a county hotline getting re-dialled nine times.
const PREAMBLE =
  'You have reached the Fort Bend County Drug Court Random UA line. Please listen carefully. ' +
  'There are new reporting times. If your phase is called, you must report between the hours of ' +
  '7AM and 10AM daily. You are not allowed to report after 10AM for drug testing. ';
const TAIL = ' Remember that you will be charged a fee for drug testing to cover the cost.';
const say = (announcement) => PREAMBLE + 'Today is ' + announcement + '.' + TAIL;

// ---------------------------------------------------------- 2026-08-04
test('2026-08-04 "phase one b and phase five" — both groups detected', function() {
  const r = detectPhaseColors(say('phase one b and phase five'));
  assert.strictEqual(r.phase1, 'Phase 1 b');
  assert.strictEqual(r.phase2, 'Phase 5', 'Phase 5 was silently dropped in production');
});

test('2026-08-04 cross-check now resolves instead of looping', function() {
  const r = doCrossCheck(say('phase one b and phase five'), 'Phase 1 b', ['Phase 1 B', 'Phase 5']);
  assert.notStrictEqual(r.match_method, 'no_match', 'this is the 9-attempt loop');
  assert.strictEqual(r.final_answer, 'Phase 1 B, Phase 5');
});

// ---------------------------------------------------------- 2026-08-05
test('2026-08-05 "gray" — plain colour still works, both casings', function() {
  assert.strictEqual(detectColor(say('gray')), 'Gray');
  assert.strictEqual(detectColor(say('Gray')), 'Gray');
});

test('2026-08-05 cross-check confirms a correct single-colour detection', function() {
  const r = doCrossCheck(say('gray'), 'Gray', ['Gray']);
  assert.strictEqual(r.match_method, 'detection_already_correct');
});

// ------------------------------------------------- word numerals, 1-10
test('every spelled-out phase numeral normalises', function() {
  const words = ['one','two','three','four','five','six','seven','eight','nine','ten'];
  words.forEach(function(w, i) {
    assert.strictEqual(
      normalizePhaseNumerals('today is phase ' + w).trim(),
      'today is phase ' + (i + 1),
      'phase ' + w + ' did not normalise'
    );
  });
});

test('phase 5 through 10 are in the vocabulary', function() {
  for (let n = 5; n <= 10; n++) {
    assert.strictEqual(detectColor('phase ' + n), 'Phase ' + n, 'phase ' + n + ' unrecognised');
  }
});

// ------------------------------------------------------ spacing variants
test('spacing variants collapse to canonical form', function() {
  ['phase 1 a', 'phase 1a', 'phase1a', 'phase  1  a'].forEach(function(v) {
    assert.strictEqual(detectColor(v), 'Phase 1 a', 'failed on ' + JSON.stringify(v));
  });
  assert.strictEqual(detectColor('phase one b'), 'Phase 1 b');
  assert.strictEqual(detectColor('phase 1b'), 'Phase 1 b');
});

// -------------------------------------------------------- partial match
test('partial match is reported distinctly from total failure', function() {
  const partial = doCrossCheck(say('phase one b'), 'Phase 1 b', ['Phase 1 B', 'Phase 5']);
  assert.strictEqual(partial.match_method, 'partial_match');
  assert.strictEqual(partial.resolved_count, 1);
  assert.strictEqual(partial.expected_count, 2);

  const none = doCrossCheck(say('mocha'), 'Mocha', ['Phase 1 B', 'Phase 5']);
  assert.strictEqual(none.match_method, 'no_match');
  assert.strictEqual(none.resolved_count, 0);
});

// ------------------------------------------------ multi-group announcements
test('three-group announcement keeps every group', function() {
  const r = detectPhaseColors(say('phase 1 a, phase 2 and phase five'));
  assert.strictEqual(r.phase1, 'Phase 1 a');
  assert.strictEqual(r.phase2, 'Phase 2, Phase 5');
});

test('prep alongside a numbered phase', function() {
  const r = detectPhaseColors(say('prep and phase three'));
  assert.strictEqual(r.phase1, 'Prep');
  assert.strictEqual(r.phase2, 'Phase 3');
});

// ----------------------------------------------------------- guard rails
test('empty transcript still yields nothing, not a false positive', function() {
  const r = detectPhaseColors('');
  assert.strictEqual(r.phase1, null);
  assert.strictEqual(r.phase2, null);
  assert.strictEqual(doCrossCheck('', 'UNKNOWN', ['Phase 1 B', 'Phase 5']).match_method, 'no_match');
});

test('IVR "press one" is not mistaken for a phase', function() {
  assert.strictEqual(normalizePhaseNumerals('press one to continue').indexOf('phase'), -1);
});
