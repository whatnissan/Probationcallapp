// WRONG_PIN: when the Montgomery hotline asking for the ID number again
// (lib/detection.js detectPinReprompt) means THIS person's PIN was rejected,
// and when it means something is wrong on our side. Pure; server.js reads
// the counts and test/wrong-pin.test.js pins every rule. Dave, 2026-10-28.
//
// Until this date a rejected PIN came back as UNKNOWN: retried all morning
// on the same PIN, told "we couldn't get a clear result", and after three
// mornings paused as a no-result streak that said nothing about the PIN —
// and that any save lifted, on the same bad PIN. Two accounts were stuck
// like that for weeks.
//
// A repeated prompt is also exactly what the hotline does when it never
// receives our tones, or when its menu changes under us. That is OUR
// problem, it hits every account dialled, and telling people their PIN is
// wrong for it would be false. Two rules keep it from being called a wrong
// PIN, both explicit here rather than judgment calls in server.js:
//
// RULE 1 — MANY ACCOUNTS AT ONCE IS OURS. When SYSTEM_FAULT_ACCOUNTS or more
//   distinct Montgomery accounts hear the repeated prompt on one morning,
//   nobody gets WRONG_PIN for it: the morning carries on as an ordinary
//   no-result retry, nothing counts toward a wrong-PIN pause, and admins are
//   alerted. Why 3: a mistyped PIN is one person's problem, and every
//   morning on file has had at most ONE account hear the repeated prompt
//   (two accounts in all, never on the same morning). Montgomery dials 5–9
//   accounts a morning (last 30 days), so a fault that reaches every call
//   crosses 3 well before the morning is out, while two genuine typos on
//   one morning still get their answer.
//
// RULE 2 — THE LINE MUST HAVE WORKED FOR SOMEONE ELSE TODAY. A wrong-PIN
//   verdict needs at least one OTHER Montgomery account to have got a result
//   heard this morning (MUST_TEST, NO_TEST or PIN_EXPIRED — all three mean
//   the hotline accepted our tones and looked an ID up). "Another account"
//   means a subscriber: never the demo account, whose fake result is written
//   every morning without dialling (lib/demo.js) and so would make this rule
//   true before any real call — it did, from 2026-10-27 to 2026-10-28 — and
//   never our own accounts (countyPoolExcludedIds). Rule 1 alone cannot
//   protect the earliest call of the day: today's call times run 6:00, 6:10,
//   6:30 ×3, 7:15, so in a morning-wide fault the 6:00 account would hear
//   the prompt twice by 6:05, with nobody else dialled yet and the count at
//   one. Without proof the line works, that account keeps retrying (the
//   next gap is an hour, by which time everyone else has been called) and,
//   if the morning ends unproven, it ends as UNKNOWN.
//
// And per account: ONE HEARING IS NOT ENOUGH on a scheduled morning — a
// single dropped tone sounds the same. The verdict needs the prompt
// repeated on two attempts that morning WITH THE SAME PIN (a PIN changed in
// between starts over). Call Now has no retries, and the person asked for
// an answer now — usually right after typing a PIN — so one hearing is
// final there, but it never counts toward the pause.
//
// THE PAUSE. WRONG_PIN_PAUSE_MORNINGS (2) scheduled mornings of WRONG_PIN on
// the PIN on file, on CONSECUTIVE days, pause the schedule as 'wrong_pin'
// (lib/time.js nextConsecutiveDayCount, shared with the expired-PIN count). Only saving a
// DIFFERENT PIN lifts it — not any save, not POST /schedule/resume (Dave):
// resuming on the same PIN fails the same way. The count starts over on a
// PIN change or a result heard (deductCreditOnce), like the expired-PIN
// count.

var SYSTEM_FAULT_ACCOUNTS = 3;
var WRONG_PIN_PAUSE_MORNINGS = 2;

// o = {
//   scheduled:              a scheduled morning (retries available) vs Call Now
//   earlierSamePin:         an earlier attempt this morning heard the repeated
//                           prompt on this same PIN
//   accountsRepromptedToday distinct Montgomery accounts that heard it today,
//                           this one included
//   othersResolvedToday     OTHER Montgomery accounts with a result heard today
// }
// → { result: 'WRONG_PIN' | 'UNKNOWN', final: bool, why }
//   final false: the retry engine carries on (result 'WRONG_PIN' marks the
//   attempt so the next one can confirm it; 'UNKNOWN' forgets it).
function repromptVerdict(o) {
  o = o || {};
  var scheduled = !!o.scheduled;
  // Rule 1. Many accounts hearing the repeat on one morning is our fault,
  // not their PINs. Checked first: it overrides even a confirmed hearing.
  if ((o.accountsRepromptedToday || 0) >= SYSTEM_FAULT_ACCOUNTS) {
    return { result: 'UNKNOWN', final: !scheduled, why: 'system_fault' };
  }
  // Rule 2 — the non-obvious one. Rule 1 counts accounts, and an account can
  // only be counted once it has been DIALLED. Call times are spread out (6:00,
  // 6:10, 6:30 ×3, 7:15 on 2026-10-28), so in a morning-wide tone fault the
  // 6:00 account hears the repeat twice by 6:05, before anyone else has been
  // called: the count is 1, rule 1 cannot fire, and without this check that
  // account is told its PIN is wrong — and paused on the second such morning,
  // purely for being first in line. So a verdict also needs positive proof
  // the line works today: another Montgomery SUBSCRIBER got a result heard —
  // not the demo account, whose fake morning row exists before anyone is
  // dialled and made this check always true, and not our own accounts. On a
  // scheduled morning the attempt stays marked WRONG_PIN and retries (the
  // next gap is an hour, by which time the rest have been called); if the
  // morning ends still unproven it is UNKNOWN. Call Now cannot wait, so it
  // gets UNKNOWN now rather than a verdict without proof.
  if (!((o.othersResolvedToday || 0) >= 1)) {
    return scheduled
      ? { result: 'WRONG_PIN', final: false, why: 'line_unproven' }
      : { result: 'UNKNOWN', final: true, why: 'line_unproven' };
  }
  // One hearing on a scheduled morning may be a single dropped tone.
  if (scheduled && !o.earlierSamePin) {
    return { result: 'WRONG_PIN', final: false, why: 'first_hearing' };
  }
  return { result: 'WRONG_PIN', final: true, why: scheduled ? 'confirmed' : 'call_now' };
}

// What a scheduled morning records when the retry engine gives up (out of
// attempts or past the cutoff). A WRONG_PIN still waiting for confirmation
// was never confirmed, so the morning is UNKNOWN, like any other no-result
// morning. Everything else is recorded as it was.
function finalFailResult(lastResult) {
  return lastResult === 'WRONG_PIN' ? 'UNKNOWN' : lastResult;
}

function pausesAfter(count) {
  return (count || 0) >= WRONG_PIN_PAUSE_MORNINGS;
}

module.exports = {
  SYSTEM_FAULT_ACCOUNTS: SYSTEM_FAULT_ACCOUNTS,
  WRONG_PIN_PAUSE_MORNINGS: WRONG_PIN_PAUSE_MORNINGS,
  repromptVerdict: repromptVerdict,
  finalFailResult: finalFailResult,
  pausesAfter: pausesAfter
};
