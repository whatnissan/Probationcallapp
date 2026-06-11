// Pure speech-detection logic, extracted verbatim from server.js so it can
// be unit-tested (test/detection.test.js). No I/O beyond console logging.
// IMPORTANT: doCrossCheck mutates FTBEND_MISRECOGNITIONS in memory — the
// object is exported (not copied) so server.js and tests share the same
// reference, matching the original single-file behavior.

const doubleMetaphone = require('double-metaphone');

// Fort Bend County colors for detection.
// Add new colors here as the hotline announces them. Validated against
// transcripts before being stored — anything not on this list (or not
// resolvable via a word-boundary misrecognition fix) is treated as UNKNOWN
// rather than coerced to a wrong color.
const FTBEND_COLORS = [
  'amber', 'apricot', 'aqua', 'auburn', 'beaver', 'black', 'blue', 'brown', 'burgundy',
  'bronze', 'canary', 'cherry', 'chestnut', 'chrome', 'coral', 'copper', 'cream', 'crimson', 'cyan',
  'emerald', 'forest', 'fuchsia', 'gold', 'gray', 'grey', 'green',
  'ivory', 'jade', 'khaki', 'lavender', 'lemon', 'lilac', 'lime', 'magenta', 'maroon', 'mint',
  'mocha', 'navy', 'olive', 'orange', 'orchid', 'peach', 'pearl', 'pink', 'plum', 'purple',
  'red', 'rose', 'ruby', 'rust', 'salmon', 'sapphire', 'scarlet', 'silver', 'slate',
  'tan', 'teal', 'turquoise', 'violet', 'white', 'wine', 'yellow'
];

// Phase group strings (Rosenberg 2 announces these alongside colors)
const FTBEND_PHASES = [
  'prep', 'phase 1 a', 'phase 1 b', 'phase 1', 'phase 2', 'phase 3', 'phase 4'
];

// Misrecognition fixes — keyed on FULL words/phrases. We match with word
// boundaries to avoid substring traps (the old bug: 'pan' triggering on
// "Spanish", "expand", etc. and coercing "chrome" announcements to "Tan").
const FTBEND_MISRECOGNITIONS = {
  'can airy': 'canary', 'canaries': 'canary', 'canari': 'canary',
  'all of': 'olive', 'all live': 'olive',
  'i very': 'ivory', 'i vory': 'ivory',
  'grey': 'gray',
  'cyn': 'cyan', 'zion': 'cyan',
  'sigh in': 'cyan', 'sigh an': 'cyan', 'sy an': 'cyan', 'psy an': 'cyan',
  'tanned': 'tan',
  'moca': 'mocha'
};

// Validate any candidate string against the known-color list. Returns the
// canonical lowercase color or null. Used by detectColor and detectPhaseColors
// so nothing unrecognized makes it into a notification.
function validateFtbendColor(candidate) {
  if (!candidate) return null;
  var c = String(candidate).toLowerCase().trim();
  if (FTBEND_COLORS.indexOf(c) >= 0) return c;
  if (FTBEND_PHASES.indexOf(c) >= 0) return c;
  return null;
}

function detectColor(transcript) {
  // Normalize spelled-out phase numerals to digits so they match canonical
  // FTBEND_PHASES entries (which use 'phase 1 b' form). Deepgram transcribes
  // spoken "phase one b" as text, not as digits, so without this the
  // word-boundary match in Pass 1 below fails. Word-boundary anchor on
  // `\bphase\s+one\b` keeps this from touching unrelated "one" mentions
  // (e.g. "press one" in IVR menu navigation).
  var lower = String(transcript || '').toLowerCase()
    .replace(/\bphase\s+one\b/g, 'phase 1')
    .replace(/\bphase\s+two\b/g, 'phase 2')
    .replace(/\bphase\s+three\b/g, 'phase 3')
    .replace(/\bphase\s+four\b/g, 'phase 4');
  console.log('[FTBEND] Analyzing: "' + lower + '"');

  // Pass 1 — known colors (longest first so "phase 1 a" beats "phase 1").
  var all = FTBEND_COLORS.concat(FTBEND_PHASES).slice().sort(function(a, b) {
    return b.length - a.length;
  });
  for (var i = 0; i < all.length; i++) {
    var colorRegex = new RegExp('\\b' + all[i].replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (colorRegex.test(lower)) {
      console.log('[FTBEND] Known color found: ' + all[i]);
      return all[i].charAt(0).toUpperCase() + all[i].slice(1);
    }
  }

  // Pass 2 — pattern extraction ("today's color is X"). Only accept if the
  // extracted word is a known color.
  var patterns = [
    /color\s+(?:is|for today is|today is|will be)\s+([a-z]+)/i,
    /today(?:'s)?\s+color\s+(?:is\s+)?([a-z]+)/i,
    /the\s+color\s+(?:is\s+)?([a-z]+)/i
  ];
  for (var p = 0; p < patterns.length; p++) {
    var match = lower.match(patterns[p]);
    if (match && match[1]) {
      var validated = validateFtbendColor(match[1]);
      if (validated) {
        console.log('[FTBEND] Pattern matched known color: ' + validated);
        return validated.charAt(0).toUpperCase() + validated.slice(1);
      }
      console.log('[FTBEND] Pattern extracted "' + match[1] + '" but not a known color — ignoring');
    }
  }

  // Pass 3 — word-boundary misrecognition fixes. NEVER use substring match
  // here: that was the 2026-05-16 chrome→Tan bug.
  for (var fix in FTBEND_MISRECOGNITIONS) {
    var fixRegex = new RegExp('\\b' + fix.replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (fixRegex.test(lower)) {
      var to = FTBEND_MISRECOGNITIONS[fix];
      console.log('[FTBEND] Misrecognition fix: ' + fix + ' -> ' + to);
      return to.charAt(0).toUpperCase() + to.slice(1);
    }
  }

  // No known color, no validated pattern, no misrecognition match — UNKNOWN.
  // Do not guess. A wrong color tells someone the wrong thing about a test.
  console.log('[FTBEND] No known color detected — returning null (UNKNOWN)');
  return null;
}

// Detect phase 1 and phase 2 announcements from speech (Rosenberg 2).
// Validates each extracted part against the known color/phase list so an
// unparseable announcement reports null (UNKNOWN) rather than storing
// arbitrary text as a "color".
function detectPhaseColors(transcript) {
  var lower = String(transcript || '').toLowerCase();
  console.log("[FTBEND] Analyzing phases in: " + lower);

  var todayIsMatch = lower.match(/today\s+is[,:]?\s*(.+?)(?:remember|you\s+will|\.|$)/i);
  if (!todayIsMatch || !todayIsMatch[1]) {
    console.log("[FTBEND] Could not find today is pattern");
    return { phase1: null, phase2: null };
  }

  var announcement = todayIsMatch[1].trim();
  console.log("[FTBEND] Raw announcement: " + announcement);

  // Split on "and" or commas, then for each part scan for any known color
  // or phase string. Anything unrecognized is dropped.
  var parts = announcement.split(/\s+and\s+|,\s*/).map(function(p) {
    return p.trim();
  }).filter(function(p) {
    return p.length > 0;
  });

  var matched = [];
  parts.forEach(function(part) {
    var detected = detectColor(part);
    if (detected) matched.push(detected);
  });

  console.log("[FTBEND] Validated phase groups: " + (matched.join(", ") || "none"));

  var phase1 = matched.length > 0 ? matched[0] : null;
  var phase2 = matched.length > 1 ? matched.slice(1).join(", ") : null;
  return { phase1: phase1, phase2: phase2 };
}

const KEYWORDS = {
  NO_TEST: ['do not test', 'not required', 'no need', 'you do not', 'do not need', 'not test'],
  MUST_TEST: ['required to test', 'must test', 'you are required', 'report for', 'required today']
};

// Phrases the Montgomery hotline uses when an ID/PIN is expired. Includes
// common Deepgram misrecognitions of "ID" (I.D., I D, idea).
// Checked BEFORE the NO_TEST / MUST_TEST keyword pass — an expired-PIN
// result is distinct from "no test today".
const PIN_EXPIRED_PHRASES = [
  'id number has expired',
  'i.d. number has expired',
  'i.d number has expired',
  'i d number has expired',
  'idea number has expired',
  'id has expired',
  'i.d. has expired',
  'i.d has expired',
  'pin has expired',
  'pin number has expired',
  'number has expired'
];
function detectPinExpired(transcript) {
  var lower = String(transcript || '').toLowerCase();
  for (var i = 0; i < PIN_EXPIRED_PHRASES.length; i++) {
    if (lower.indexOf(PIN_EXPIRED_PHRASES[i]) >= 0) return true;
  }
  return false;
}

// Phonetic match using Double Metaphone. Returns true if either word's
// primary or secondary code matches the other's primary or secondary.
// Example: 'moca' [MK,MK] vs 'mocha' [MX,MK] → MK matches MK → true.
function phoneticMatch(a, b) {
  if (!a || !b) return false;
  var ca = doubleMetaphone(String(a));
  var cb = doubleMetaphone(String(b));
  // ca = [primary, secondary]; cb = [primary, secondary]; cross-match all 4 pairings
  if (ca[0] && ca[0] === cb[0]) return true;
  if (ca[0] && ca[0] === cb[1]) return true;
  if (ca[1] && ca[1] === cb[0]) return true;
  if (ca[1] && ca[1] === cb[1]) return true;
  return false;
}

// Cross-check our Deepgram-derived detection against finishprobation's
// published ground truth. Mutates FTBEND_MISRECOGNITIONS in memory when a
// phonetic match is found so the rest of today's calls/retries benefit.
//
// groundTruthArr: array of strings (testGroups from finishprobation), e.g.
//   ['Mocha'] or ['Prep', 'Phase 1 B'].
//
// For multi-word ground-truth items (e.g. 'Phase 1 B'), phonetic matching
// is skipped — we rely on substring matching only (the transcript is
// already phase-numeral-normalized by detectColor's pre-pass, so 'phase
// one b' → 'phase 1 b' before this check runs).
function doCrossCheck(transcript, ourDetection, groundTruthArr) {
  if (!groundTruthArr || groundTruthArr.length === 0) {
    return { match_method: 'no_ground_truth', final_answer: null, misrecognition_added: null };
  }

  var joined = groundTruthArr.join(', ');
  var joinedLower = joined.toLowerCase();
  var ourLower = (ourDetection || '').toLowerCase();

  // Fast path 1: detection matches the full joined ground truth.
  if (ourLower && ourLower === joinedLower) {
    return { match_method: 'detection_already_correct', final_answer: joined, misrecognition_added: null };
  }
  // Fast path 2: single-element array matches our detection.
  if (groundTruthArr.length === 1 && ourLower && ourLower === groundTruthArr[0].toLowerCase()) {
    return { match_method: 'detection_already_correct', final_answer: joined, misrecognition_added: null };
  }

  var transcriptLower = String(transcript || '').toLowerCase();
  var transcriptTokens = transcriptLower.split(/[^a-z0-9]+/).filter(function(t) {
    return t.length >= 2;
  });

  // Every ground-truth item must be verifiable. Substring beats phonetic;
  // for multi-word items phonetic doesn't apply (relies on substring only).
  var addedMisrecognitions = [];
  var sawPhonetic = false;
  var allResolved = groundTruthArr.every(function(item) {
    var itemLower = item.toLowerCase();
    if (transcriptLower.indexOf(itemLower) !== -1) return true;
    if (itemLower.indexOf(' ') !== -1) return false; // multi-word: no phonetic fallback
    for (var i = 0; i < transcriptTokens.length; i++) {
      if (phoneticMatch(transcriptTokens[i], itemLower)) {
        addedMisrecognitions.push({ token: transcriptTokens[i], target: itemLower });
        sawPhonetic = true;
        return true;
      }
    }
    return false;
  });

  if (!allResolved) {
    return { match_method: 'no_match', final_answer: null, misrecognition_added: null };
  }

  if (sawPhonetic) {
    // Mutate the in-memory map so the rest of today's calls/retries pick up
    // these phonetic mappings via Pass 3 of detectColor.
    addedMisrecognitions.forEach(function(m) {
      FTBEND_MISRECOGNITIONS[m.token] = m.target;
      console.log('[FTBEND-XCHECK] Auto-added misrecognition: "' + m.token + '" -> "' + m.target + '" (in-memory only; codify in code for permanence)');
    });
    var addedTokens = addedMisrecognitions.map(function(m) { return m.token; }).join(', ');
    return { match_method: 'phonetic', final_answer: joined, misrecognition_added: addedTokens };
  }

  return { match_method: 'substring', final_answer: joined, misrecognition_added: null };
}

module.exports = {
  FTBEND_COLORS: FTBEND_COLORS,
  FTBEND_PHASES: FTBEND_PHASES,
  FTBEND_MISRECOGNITIONS: FTBEND_MISRECOGNITIONS,
  KEYWORDS: KEYWORDS,
  PIN_EXPIRED_PHRASES: PIN_EXPIRED_PHRASES,
  validateFtbendColor: validateFtbendColor,
  detectColor: detectColor,
  detectPhaseColors: detectPhaseColors,
  detectPinExpired: detectPinExpired,
  phoneticMatch: phoneticMatch,
  doCrossCheck: doCrossCheck
};
