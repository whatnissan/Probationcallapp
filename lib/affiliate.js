// Affiliate commissions on Stripe Connect Express (2026-09-02): the pure
// parts. Money model is ACCRUE, HOLD, PAY — not destination charges — because
// refund safety wins: a commission is a ledger row for HOLD_DAYS, so a refund
// in that window moves no money, and only rows past the hold are ever
// transferred, once a month, in one transfer per affiliate. See the
// contract §4.14 for the reasoning against splitting at checkout.
// HOLD_DAYS is NOT only refund safety. Tax research (2026-09-03): the IRS
// deems a payment made when an amount is credited AND usable, at fair
// market value — so the hold is what keeps a commission "restricted", i.e.
// not yet income, until the clawback window closes. That is what keeps
// Year-1 / Year-2 reporting clean when a December sale refunds in January.
// Do not shorten it without understanding that.
var HOLD_DAYS = 30;
var MIN_PAYOUT_CENTS = 2000;
var STATUSES = ['held', 'available', 'paid', 'reversed', 'reversal_failed', 'failed', 'transferred', 'credited'];

function availableAt(createdMs) { return new Date(createdMs + HOLD_DAYS * 86400000).toISOString(); }

// How a row reads right now. 'held' past its available_at counts as
// available even before the daily promote job flips the column.
function effectiveStatus(row, nowMs) {
  if (row.status === 'held' && row.available_at && Date.parse(row.available_at) <= nowMs) return 'available';
  if (row.status === 'transferred') return 'paid'; // pre-2026-09 rows
  if (row.status === 'credited') return 'available'; // pre-2026-09 non-Connect rows
  return row.status;
}

function summarizeBalances(rows, nowMs) {
  var out = { heldCents: 0, availableCents: 0, paidCents: 0, reversedCents: 0, lifetimeCents: 0 };
  (rows || []).forEach(function(r) {
    var st = effectiveStatus(r, nowMs), c = r.amount_cents || 0;
    if (st === 'held') out.heldCents += c;
    else if (st === 'available') out.availableCents += c;
    else if (st === 'paid') out.paidCents += c;
    else if (st === 'reversed' || st === 'reversal_failed') out.reversedCents += c;
    if (st !== 'reversed' && st !== 'reversal_failed' && st !== 'failed') out.lifetimeCents += c;
  });
  return out;
}

// The rows a monthly batch could pay: available, or held past its date.
function eligibleRows(rows, nowMs) {
  return (rows || []).filter(function(r) { return effectiveStatus(r, nowMs) === 'available'; });
}
function sumCents(rows) {
  return (rows || []).reduce(function(n, r) { return n + (r.amount_cents || 0); }, 0);
}

// The rows a monthly batch pays, and the decision whether a batch happens at
// all. `payoutsEnabled` here must come from a LIVE Stripe read — this is the
// final gate, not a screen.
function payoutPlan(rows, nowMs, payoutsEnabled, minCents) {
  var min = minCents || MIN_PAYOUT_CENTS;
  var eligible = eligibleRows(rows, nowMs);
  var total = sumCents(eligible);
  if (!payoutsEnabled) return { pay: false, reason: 'payouts_not_enabled', amountCents: total, rows: eligible };
  if (total < min) return { pay: false, reason: 'below_minimum', amountCents: total, rows: eligible };
  return { pay: true, amountCents: total, rows: eligible };
}

// How long a cached Connect state is trusted to SKIP an affiliate. Past
// this, a cached "not payouts-enabled" is treated as stale and the live
// gate decides instead — so a webhook we never received costs one API call,
// not a month of an affiliate waiting on money they are owed.
var CONNECT_STATE_TRUST_MS = 7 * 86400000;

// Cheap pre-screen, run BEFORE any Stripe call, on stored state only.
//
// THE INVARIANT: cached state may only ever PREVENT a payout attempt, never
// authorize one. Every `attempt: true` still has to clear the live
// payoutPlan gate before money moves. That is what makes a stale cache
// fail-safe in the money direction — the worst a wrong cache can do is
// delay a payout to next month or waste one API call, never pay an account
// that cannot receive it.
//
// Unknown is not false: a NULL payouts_enabled (never synced) or a sync
// older than CONNECT_STATE_TRUST_MS falls through to the live gate rather
// than skipping.
function payoutPreScreen(profile, rows, nowMs, minCents) {
  var eligible = eligibleRows(rows, nowMs);
  var total = sumCents(eligible);
  var out = { attempt: false, amountCents: total, rows: eligible };
  if (!profile || !profile.stripe_connect_id) {
    out.reason = 'no_connect_account';
    return out;
  }
  if (total < (minCents || MIN_PAYOUT_CENTS)) {
    out.reason = 'below_minimum';
    return out;
  }
  var syncedAt = profile.stripe_connect_updated_at ? Date.parse(profile.stripe_connect_updated_at) : NaN;
  var fresh = !isNaN(syncedAt) && (nowMs - syncedAt) < CONNECT_STATE_TRUST_MS;
  if (profile.stripe_connect_payouts_enabled === false && fresh) {
    out.reason = 'payouts_not_enabled_cached';
    return out;
  }
  out.attempt = true;
  return out;
}

// §4.14 POST /referral/apply — what to do, given only facts. Pure so the
// ORDERING can be pinned by a test, because the ordering is the subtle part:
//
// IDEMPOTENCY OUTRANKS THE PURCHASE GATE. An account that already carries
// the submitted code is answered 'idempotent' even if it has since bought
// something. Check the purchase first instead and the sequence
// apply -> buy -> the app retries a request whose response it never saw
// answers 'after_purchase' for a call that had already succeeded.
//
//   idempotent     -> 200 { applied: true, bonusCredits: 0 }
//   conflict       -> 409 referral_already_applied
//   after_purchase -> 409 referral_after_purchase
//   apply          -> claim it
function referralApplyDecision(existingCode, submittedCode, hasPurchase) {
  if (existingCode) return existingCode === submittedCode ? 'idempotent' : 'conflict';
  if (hasPurchase) return 'after_purchase';
  return 'apply';
}

// What a refund/dispute does to one row.
//   ledger           — held/available: mark reversed, no money moved
//   reverse_transfer — paid: reverse the Stripe transfer (may go negative
//                      if the affiliate already withdrew; platform liable)
//   noop             — already terminal
function clawbackAction(row) {
  var st = row.status;
  if (st === 'held' || st === 'available' || st === 'credited') return 'ledger';
  if ((st === 'paid' || st === 'transferred') && row.stripe_transfer_id) return 'reverse_transfer';
  if (st === 'failed') return 'ledger';
  return 'noop';
}

// True when Stripe is waiting on the AFFILIATE for something — anything in
// currently_due or past_due (migration 048). A NULL column means we have
// never synced this account, which is UNKNOWN, not "nothing due": it
// returns false so connectState falls back to its pre-048 answer rather
// than inventing a reassurance we cannot support.
function hasAnyRequirement(v) { return Array.isArray(v) && v.length > 0; }
function requirementsOutstanding(profile) {
  if (!profile) return false;
  return hasAnyRequirement(profile.stripe_connect_requirements_currently_due) ||
         hasAnyRequirement(profile.stripe_connect_requirements_past_due);
}

// Connect state for the client, from the cached profile columns.
// details_submitted alone cannot tell "Stripe is reviewing you" apart from
// "you submitted, and Stripe came back asking for more" — on three booleans
// both look identical, and this value goes straight to the app through
// contract §4.14, where §1 requires clients to degrade honestly. The 048
// requirements columns settle it: an outstanding requirement means the ball
// is in the affiliate's court (in_progress); details submitted with nothing
// due means Stripe is reviewing (pending_review).
function connectState(profile) {
  if (!profile || !profile.stripe_connect_id) return 'not_started';
  if (profile.stripe_connect_payouts_enabled) return 'ready';
  if (profile.stripe_connect_details_submitted) {
    return requirementsOutstanding(profile) ? 'in_progress' : 'pending_review';
  }
  return 'in_progress';
}

// The first of next month, in Central time, as YYYY-MM-DD.
function nextPayoutDate(nowMs) {
  var d = new Date(nowMs);
  var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric' }).formatToParts(d);
  var y = +parts.find(function(p) { return p.type === 'year'; }).value, m = +parts.find(function(p) { return p.type === 'month'; }).value;
  var ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return ny + '-' + String(nm).padStart(2, '0') + '-01';
}

module.exports = { HOLD_DAYS: HOLD_DAYS, MIN_PAYOUT_CENTS: MIN_PAYOUT_CENTS, STATUSES: STATUSES, availableAt: availableAt, effectiveStatus: effectiveStatus, summarizeBalances: summarizeBalances, payoutPlan: payoutPlan, payoutPreScreen: payoutPreScreen, eligibleRows: eligibleRows, CONNECT_STATE_TRUST_MS: CONNECT_STATE_TRUST_MS, clawbackAction: clawbackAction, referralApplyDecision: referralApplyDecision, connectState: connectState, requirementsOutstanding: requirementsOutstanding, nextPayoutDate: nextPayoutDate };
