const test = require('node:test');
const assert = require('node:assert');

const {
  FTBEND_MISRECOGNITIONS,
  validateFtbendColor,
  detectColor,
  detectPhaseColors,
  detectPinExpired,
  phoneticMatch,
  doCrossCheck
} = require('../lib/detection');

// doCrossCheck mutates FTBEND_MISRECOGNITIONS at runtime — snapshot and
// restore around every test so phonetic-learning tests can't bleed into
// detectColor tests.
const ORIGINAL_KEYS = Object.keys(FTBEND_MISRECOGNITIONS);
const ORIGINAL_ENTRIES = Object.assign({}, FTBEND_MISRECOGNITIONS);
test.afterEach(function() {
  Object.keys(FTBEND_MISRECOGNITIONS).forEach(function(k) {
    if (ORIGINAL_KEYS.indexOf(k) < 0) delete FTBEND_MISRECOGNITIONS[k];
  });
  Object.assign(FTBEND_MISRECOGNITIONS, ORIGINAL_ENTRIES);
});

test('detectColor: finds a plain known color', function() {
  assert.strictEqual(detectColor('the color for today is blue'), 'Blue');
});

test('detectColor: regression — chrome is a known color, never coerced to Tan (2026-05-16 bug)', function() {
  assert.strictEqual(detectColor("today's color is chrome"), 'Chrome');
});

test('detectColor: regression — "pan" inside Spanish/expand must not trigger tan', function() {
  assert.strictEqual(detectColor('para espanol oprima dos, Spanish menu, expand'), null);
});

test('detectColor: misrecognition fix uses word boundaries ("sigh in" → Cyan)', function() {
  assert.strictEqual(detectColor('the color is sigh in today'), 'Cyan');
});

test('detectColor: unknown word in pattern position returns null, never a guess', function() {
  assert.strictEqual(detectColor("today's color is blurple"), null);
});

test('detectColor: empty/garbage input returns null', function() {
  assert.strictEqual(detectColor(''), null);
  assert.strictEqual(detectColor(null), null);
  assert.strictEqual(detectColor('thank you for calling goodbye'), null);
});

test('detectColor: spoken phase numerals are normalized ("phase one b" → Phase 1 b)', function() {
  assert.strictEqual(detectColor('today is phase one b'), 'Phase 1 b');
});

test('detectColor: longest phase wins ("phase 1 a" beats "phase 1")', function() {
  assert.strictEqual(detectColor('phase 1 a must report'), 'Phase 1 a');
});

test('detectColor: "press one" IVR menu text is not mangled by numeral normalization', function() {
  assert.strictEqual(detectColor('press one for english'), null);
});

test('validateFtbendColor: canonicalizes known colors and phases, rejects unknowns', function() {
  assert.strictEqual(validateFtbendColor(' GREY '), 'grey');
  assert.strictEqual(validateFtbendColor('phase 2'), 'phase 2');
  assert.strictEqual(validateFtbendColor('blurple'), null);
  assert.strictEqual(validateFtbendColor(null), null);
});

test('detectPhaseColors: parses "today is X and Y" announcements (Rosenberg 2)', function() {
  var r = detectPhaseColors('Today is prep and phase one b. Remember you will be tested.');
  assert.strictEqual(r.phase1, 'Prep');
  assert.strictEqual(r.phase2, 'Phase 1 b');
});

test('detectPhaseColors: single group announcement', function() {
  var r = detectPhaseColors('today is phase three. remember to bring your id');
  assert.strictEqual(r.phase1, 'Phase 3');
  assert.strictEqual(r.phase2, null);
});

test('detectPhaseColors: unparseable announcement reports nulls, not arbitrary text', function() {
  var r = detectPhaseColors('today is gobbledygook and nonsense');
  assert.strictEqual(r.phase1, null);
  assert.strictEqual(r.phase2, null);
});

test('detectPhaseColors: no "today is" pattern at all', function() {
  var r = detectPhaseColors('thank you for calling the hotline');
  assert.strictEqual(r.phase1, null);
  assert.strictEqual(r.phase2, null);
});

test('detectPinExpired: matches hotline phrasings and Deepgram mishears', function() {
  assert.strictEqual(detectPinExpired('your i.d. number has expired, please contact your officer'), true);
  assert.strictEqual(detectPinExpired('your idea number has expired'), true);
  assert.strictEqual(detectPinExpired('pin number has expired'), true);
  assert.strictEqual(detectPinExpired('you do not need to test today'), false);
  assert.strictEqual(detectPinExpired(''), false);
});

test('phoneticMatch: moca/mocha match, unrelated words do not', function() {
  assert.strictEqual(phoneticMatch('moca', 'mocha'), true);
  assert.strictEqual(phoneticMatch('teel', 'teal'), true);
  assert.strictEqual(phoneticMatch('blue', 'red'), false);
  assert.strictEqual(phoneticMatch('', 'red'), false);
});

test('doCrossCheck: no ground truth', function() {
  var r = doCrossCheck('anything', 'Blue', null);
  assert.strictEqual(r.match_method, 'no_ground_truth');
  assert.strictEqual(r.final_answer, null);
});

test('doCrossCheck: detection already correct (single color)', function() {
  var r = doCrossCheck('the color is mocha', 'Mocha', ['Mocha']);
  assert.strictEqual(r.match_method, 'detection_already_correct');
  assert.strictEqual(r.final_answer, 'Mocha');
});

test('doCrossCheck: substring confirms multi-word phase groups', function() {
  var r = doCrossCheck('today is prep and phase 1 b', 'Prep', ['Prep', 'Phase 1 B']);
  assert.strictEqual(r.match_method, 'substring');
  assert.strictEqual(r.final_answer, 'Prep, Phase 1 B');
});

test('doCrossCheck: phonetic recovery learns the misrecognition in memory', function() {
  var r = doCrossCheck('the color today is teel', 'UNKNOWN', ['Teal']);
  assert.strictEqual(r.match_method, 'phonetic');
  assert.strictEqual(r.final_answer, 'Teal');
  assert.strictEqual(r.misrecognition_added, 'teel');
  // The learned mapping must be live for the rest of the day's calls.
  assert.strictEqual(FTBEND_MISRECOGNITIONS['teel'], 'teal');
  assert.strictEqual(detectColor('the color today is teel'), 'Teal');
});

test('doCrossCheck: no match when transcript cannot verify ground truth', function() {
  var r = doCrossCheck('completely unrelated audio', 'UNKNOWN', ['Phase 1 B']);
  assert.strictEqual(r.match_method, 'no_match');
  assert.strictEqual(r.final_answer, null);
});

test('doCrossCheck: multi-word items get no phonetic fallback', function() {
  // 'phaze 1 b' is phonetically close but multi-word → substring only → no_match
  var r = doCrossCheck('today is phaze won bee', 'UNKNOWN', ['Phase 1 B']);
  assert.strictEqual(r.match_method, 'no_match');
});
