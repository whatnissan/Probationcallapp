
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const path = require('path');
const cron = require('node-cron');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const doubleMetaphone = require('double-metaphone');


// --- BREVO EMAIL VIA HTTP API ---
const brevoMail = {
  send: async (msg) => {
    try {
      var fromEmail = typeof msg.from === "object" ? msg.from.email : msg.from;
      var fromName = typeof msg.from === "object" ? msg.from.name : "ProbationCall";
      console.log("[EMAIL] Sending via Brevo API to:", msg.to);
      var response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": process.env.BREVO_KEY,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sender: { name: fromName, email: fromEmail },
          to: [{ email: msg.to }],
          subject: msg.subject,
          textContent: msg.text || "",
          htmlContent: msg.html || msg.text
        })
      });
      if (response.ok) {
        console.log("[EMAIL] ✅ Sent successfully to", msg.to);
        return { success: true };
      } else {
        var err = await response.text();
        console.error("[EMAIL] ❌ Brevo API Error:", err);
        throw new Error(err);
      }
    } catch (error) {
      console.error("[EMAIL] ❌ Brevo Error:", error.message);
      throw error;
    }
  }
};
// ---------------------------------


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEV_EMAILS = ['whatnissan@gmail.com', 'whatnissan@protonmail.com'];

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

if (process.env.BREVO_KEY) {
  console.log('[EMAIL] Brevo configured');
}

const pendingCalls = new Map();
const wsClients = new Set();
const scheduledJobs = new Map();

const TWILIO_VOICE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
// These have fallbacks to the historical hardcoded values so the deploy
// keeps working unchanged — set the env vars in Railway to override.
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || 'MG8adbb793f6b8c100da6770f6f0707258';
const WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+15558965863';
const FROM_EMAIL = process.env.FROM_EMAIL || 'alerts@probationcall.com';

// Time restrictions: 6:00 AM to 2:59 PM
const MIN_HOUR = 6;
const MAX_HOUR = 14;

// Stagger calls over this many minutes to prevent server overload
const STAGGER_MINUTES = 15;

// Supported Counties Configuration
const COUNTIES = {
  'montgomery': {
    name: 'Montgomery County',
    number: '+19362834848',
    process: 'standard',
    minHour: 6,
    maxHour: 14
  },
  'ftbend': {
    name: 'Fort Bend County',
    number: '+12812383668',
    process: 'color',
    minHour: 5,
    maxHour: 9
  }
};

// Fort Bend Offices (3 locations)
const FTBEND_OFFICES = {
  'missouri': { 
    name: 'Missouri City', 
    number: '+12812383668',
    label: 'Missouri City'
  },
  'rosenberg': { 
    name: 'Rosenberg', 
    number: '+12812383669',
    label: 'Rosenberg'
  },
  'rosenberg2': { 
    name: 'Rosenberg 2', 
    number: '+12812383671',
    label: 'Rosenberg Phase',
    hasPhases: true
  }
};

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

function getCountyConfig(countyId) {
  return COUNTIES[countyId] || COUNTIES['montgomery'];
}



// Affiliate settings
const AFFILIATE_COMMISSION_PERCENT = 30;

// Format phone to E.164 (+1XXXXXXXXXX)
function formatPhone(phone) {
  if (!phone) return phone;
  var cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (cleaned.length === 11 && cleaned[0] === '1') {
    return '+' + cleaned;
  }
  return phone.startsWith('+') ? phone : '+' + cleaned;
} // 30% commission
const MIN_PAYOUT_CENTS = 2000; // $20 minimum payout
const REFERRED_BONUS_CREDITS = 5; // Bonus credits for new users who use referral

// Affiliate program — global on/off switch.
// When false: bundle and subscription purchases still grant the buyer's
// credits as normal, but the entire commission/transfer/payout machinery
// is skipped, every /api/affiliate/* and /api/admin/*referral endpoint
// returns 403, and the affiliate dashboard UI is hidden. Flipping to true
// (set env AFFILIATE_ENABLED=true) cleanly re-enables everything — no
// affiliate code was deleted, only gated.
var AFFILIATE_ENABLED = process.env.AFFILIATE_ENABLED === 'true';

// Middleware: 403 if the affiliate program is off. Used on every endpoint
// that mutates affiliate state or reveals affiliate-only data.
function requireAffiliateEnabled(req, res, next) {
  if (!AFFILIATE_ENABLED) {
    return res.status(403).json({ error: 'Affiliate program is not currently active.' });
  }
  next();
}

// §4 — Safe affiliate-code resolver. Single source of truth for "who owns
// this referral code?" — used by every money-touching path so a code
// collision can never silently attribute commission to a random profile.
//
// Behavior:
//   - Normalizes input to uppercase (every writer also uppercases, but
//     code coming back from old profile.referred_by rows might not be —
//     normalize on read too).
//   - Returns the matching profile row, or null if 0 matches.
//   - If MORE THAN ONE row matches (duplicate codes, possible if the
//     migration 008 UNIQUE constraint hasn't been applied yet or has
//     been dropped), logs a loud error and returns null — refusing to
//     pay commission rather than guess. Once the constraint is in place
//     this branch is unreachable.
async function resolveAffiliateByCode(rawCode) {
  if (!rawCode) return null;
  var code = String(rawCode).toUpperCase().trim();
  if (!code) return null;
  // limit(2) — we only care whether there are 0, 1, or "more than 1" matches.
  var r = await supabase.from('profiles')
    .select('id, email, referral_code')
    .eq('referral_code', code)
    .limit(2);
  if (r.error) {
    console.error('[AFFILIATE] resolveAffiliateByCode lookup error for "' + code + '":', r.error);
    return null;
  }
  if (!r.data || r.data.length === 0) return null;
  if (r.data.length > 1) {
    console.error('[AFFILIATE] DUPLICATE referral_code "' + code + '" matches multiple profiles (' + r.data.map(function(p) { return p.id.slice(0, 8); }).join(', ') + ') — refusing to attribute commission. Apply migration 008 (UNIQUE constraint) and dedupe before this can recur.');
    return null;
  }
  return r.data[0];
}

// §6.B — Cached Stripe Connect account status. Pre-transfer code calls
// getConnectAccountStatus(acctId) to verify the destination is actually
// payouts_enabled before firing stripe.transfers.create. Sending money to
// an account that isn't payouts_enabled either fails outright or lands
// the funds in a frozen holding balance the affiliate can't withdraw.
//
// In-memory cache with 60s TTL so a burst of commissions for the same
// affiliate doesn't hammer the Stripe API. The §1 account.updated handler
// also writes into this cache so a recent webhook reflects immediately
// without waiting for the TTL to expire.
//
// The cached profile.stripe_connect_* columns (from migration 007) are
// for admin display and reporting — they are NOT used as the source of
// truth for transfer decisions, because webhooks can lag.
var _connectAccountCache = new Map();
var CONNECT_ACCOUNT_CACHE_TTL_MS = 60 * 1000;

async function getConnectAccountStatus(accountId) {
  if (!accountId) return null;
  var cached = _connectAccountCache.get(accountId);
  if (cached && (Date.now() - cached.fetchedAt) < CONNECT_ACCOUNT_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    var account = await stripe.accounts.retrieve(accountId);
    var status = {
      id: account.id,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted
    };
    _connectAccountCache.set(accountId, { data: status, fetchedAt: Date.now() });
    // Bound the cache so it can't grow unbounded across many affiliates.
    if (_connectAccountCache.size > 1000) {
      var first = _connectAccountCache.keys().next().value;
      _connectAccountCache.delete(first);
    }
    return status;
  } catch (e) {
    console.error('[CONNECT] Failed to retrieve account ' + accountId + ':', e.message);
    return null;
  }
}

// Sync the cached status onto the profile row. Called from both the
// pre-transfer check (when it just fetched fresh data) and the
// account.updated webhook handler. Failures here are non-critical;
// the cache columns are display-only.
async function syncConnectStatusToProfile(accountId, status) {
  if (!accountId || !status) return;
  try {
    var r = await supabase.from('profiles').update({
      stripe_connect_charges_enabled: status.charges_enabled,
      stripe_connect_payouts_enabled: status.payouts_enabled,
      stripe_connect_details_submitted: status.details_submitted,
      stripe_connect_updated_at: new Date().toISOString()
    }).eq('stripe_connect_id', accountId);
    if (r.error) console.error('[CONNECT] Profile cache sync failed for ' + accountId + ':', r.error);
  } catch (e) {
    console.error('[CONNECT] Profile cache sync exception for ' + accountId + ':', e.message);
  }
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

// Atomic credit-add via the add_credits_with_ledger RPC. Updates
// profiles.credits AND inserts a credit_transactions row in one transaction
// so they can never drift. Returns the new balance, or null on failure
// (always logs the error). Callers MUST use this for every credit ADD —
// directly updating profiles.credits would skip the ledger entry.
async function recordCreditAdd(opts) {
  if (!opts || !opts.userId || !opts.amount || opts.amount <= 0 || !opts.source) {
    console.error('[CREDITS] recordCreditAdd: invalid args', JSON.stringify(opts));
    return null;
  }
  var rpc = await supabase.rpc('add_credits_with_ledger', {
    p_user_id: opts.userId,
    p_amount: opts.amount,
    p_source: opts.source,
    p_note: opts.note || null,
    p_performed_by: opts.performedBy || null,
    p_stripe_session_id: opts.stripeSessionId || null,
    p_stripe_invoice_id: opts.stripeInvoiceId || null
  });
  if (rpc.error) {
    console.error('[CREDITS] add_credits_with_ledger RPC failed for ' + opts.userId.slice(0, 8) + ' source=' + opts.source + ':', rpc.error.message || rpc.error);
    return null;
  }
  return rpc.data;
}

// Idempotency-keyed credit deduction. Returns true if a credit was deducted
// (or would have been, for a dev user) — caller MUST then write billed_at on
// the matching call_history row in the same insert. Returns false if we
// skipped (already billed, no credits, or DB error).
//
// Primary defense: a caller-supplied alreadyBilledCheck() that queries
// call_history.billed_at — survives restart, redeploy, and pendingCalls being
// in-memory. Fast-path: the in-memory _creditDeductionKeys Set saves a DB
// roundtrip on the second-and-later webhook delivery for the same call.
var _creditDeductionKeys = new Set();
async function deductCreditOnce(userId, idempotencyKey, options) {
  options = options || {};
  if (!userId || !idempotencyKey) return false;

  // Fast-path (in-memory, lost on restart).
  if (_creditDeductionKeys.has(idempotencyKey)) {
    console.log('[CREDITS] Skip (fast-path) for ' + userId.slice(0, 8) + ' key=' + idempotencyKey);
    return false;
  }

  // Durable check — the source of truth. Survives Railway redeploys and
  // process restarts, which the fast-path cannot.
  if (typeof options.alreadyBilledCheck !== 'function') {
    console.error('[CREDITS] Refusing to deduct without alreadyBilledCheck for key=' + idempotencyKey);
    return false;
  }
  try {
    var already = await options.alreadyBilledCheck();
    if (already) {
      console.log('[CREDITS] Skip (durable) for ' + userId.slice(0, 8) + ' key=' + idempotencyKey + ' — already billed');
      _creditDeductionKeys.add(idempotencyKey);
      return false;
    }
  } catch (e) {
    console.error('[CREDITS] Durable check failed for ' + userId.slice(0, 8) + ' key=' + idempotencyKey + ':', e.message);
    return false; // refuse to deduct when we can't verify
  }

  try {
    var pr = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
    if (pr.error || !pr.data) {
      console.error('[CREDITS] Profile lookup failed for ' + userId.slice(0, 8) + ':', pr.error);
      return false;
    }
    var devUser = isDev(pr.data.email);
    if (!devUser && (pr.data.credits || 0) < 1) {
      console.log('[CREDITS] No credits to deduct for ' + userId.slice(0, 8));
      return false;
    }

    if (!devUser) {
      var newCredits = pr.data.credits - 1;
      var upd = await supabase.from('profiles').update({ credits: newCredits }).eq('id', userId);
      if (upd.error) {
        console.error('[CREDITS] Deduction update failed for ' + userId.slice(0, 8) + ':', upd.error);
        return false;
      }
      console.log('[CREDITS] Deducted 1 from ' + userId.slice(0, 8) + ' (' + pr.data.credits + ' -> ' + newCredits + ') key=' + idempotencyKey);
      // A successful billable result resets both skip counters: the user is
      // back in good standing on credits AND the hotline accepted their PIN.
      await supabase.from('user_schedules').update({ no_credit_skip_count: 0, consecutive_pin_expired: 0 }).eq('user_id', userId);
      if (newCredits <= 2 && options.notifyNumber !== undefined) {
        sendLowCreditAlert(userId, newCredits, options.notifyNumber, options.notifyEmail, options.notifyMethod);
      }
    } else {
      console.log('[CREDITS] Dev user ' + userId.slice(0, 8) + ' — no deduction; will still mark billed_at key=' + idempotencyKey);
    }

    _creditDeductionKeys.add(idempotencyKey);
    if (_creditDeductionKeys.size > 10000) {
      var first = _creditDeductionKeys.values().next().value;
      _creditDeductionKeys.delete(first);
    }
    // true = caller should write billed_at on the call_history insert
    return true;
  } catch (e) {
    console.error('[CREDITS] Exception deducting for ' + userId.slice(0, 8) + ':', e.message);
    return false;
  }
}

// If the user has had several consecutive no-result calls, something
// structural is wrong (hotline unreachable, carrier route broken, PIN
// changed, etc.). Pause their schedule and tell them — beats trying the
// same call daily.
//
// "No usable result" outcomes that count toward the streak:
//   UNKNOWN       — transcript present but no keyword matched
//   CALL_FAILED   — Twilio terminal failure, no audio captured (Gap 1)
//   HOTLINE_DOWN  — Deepgram returned empty on all 3 retries (Gap 3)
//
// PIN_EXPIRED is INVISIBLE to this streak — filtered out of the lookback
// query entirely. PIN expirations have their own dedicated counter
// (consecutive_pin_expired, handled by handlePinExpiredResult) that
// auto-disables after 2 in a row. Excluding PIN_EXPIRED from this query
// honors "neither increment nor reset": a PIN_EXPIRED row neither counts
// toward the no-result streak nor occupies a slot that could push older
// no-result rows out of the window.
//
// MUST_TEST, NO_TEST, NO_CREDITS, and FtBend COLOR:* / P1:* results
// all break the streak (they fill a row slot without matching the
// no-result filter), as before.
//
// Function name kept as "checkConsecutiveUnknown" for log continuity
// and minimal churn — its scope is broader than UNKNOWN now.
var UNKNOWN_STREAK_THRESHOLD = 3;
var NO_RESULT_STATUSES = ['UNKNOWN', 'CALL_FAILED', 'HOTLINE_DOWN'];
async function checkConsecutiveUnknown(userId, lastReason, notifyNumber, notifyEmail, notifyMethod) {
  // PIN_EXPIRED is filtered OUT here so it neither contributes to nor
  // occupies a slot in the no-result streak. Its own counter handles it.
  var recent = await supabase.from('call_history')
    .select('result, created_at')
    .eq('user_id', userId)
    .neq('result', 'PIN_EXPIRED')
    .order('created_at', { ascending: false })
    .limit(UNKNOWN_STREAK_THRESHOLD);
  if (recent.error || !recent.data) return;
  // The current call's row hasn't been inserted yet when we run, so we
  // count (THRESHOLD - 1) prior no-result rows plus the one we just produced.
  var priorNoResult = recent.data.filter(function(r) {
    return NO_RESULT_STATUSES.indexOf(r.result) >= 0;
  }).length;
  if (priorNoResult < UNKNOWN_STREAK_THRESHOLD - 1) return;
  // Don't re-fire on every subsequent no-result call. Check schedule is still enabled.
  var sched = await supabase.from('user_schedules').select('enabled').eq('user_id', userId).single();
  if (!sched.data || sched.data.enabled === false) return;
  console.log('[UNKNOWN-STREAK] Pausing schedule for ' + userId.slice(0, 8) + ' after ' + UNKNOWN_STREAK_THRESHOLD + ' no-result calls (UNKNOWN/CALL_FAILED/HOTLINE_DOWN; PIN_EXPIRED excluded)');
  await supabase.from('user_schedules').update({ enabled: false }).eq('user_id', userId);
  if (scheduledJobs.has(userId)) {
    scheduledJobs.get(userId).stop();
    scheduledJobs.delete(userId);
  }
  // Stop any in-flight retry sequence for this user — schedule is now off,
  // we shouldn't keep retrying.
  await supabase.from('pending_retries').delete().eq('user_id', userId).then(function() {}, function(e) {
    console.error('[RETRY] Failed to clean pending_retries on auto-pause:', e.message);
  });
  // Message must read sensibly whether the streak was caused by
  // transcripts we couldn't parse (UNKNOWN/HOTLINE_DOWN) OR calls that
  // never connected (CALL_FAILED). "Didn't complete successfully" covers
  // both. Credit-savings line removed — none of these outcomes bill.
  var userMsg = '⏸ ProbationCall paused\n\nYour last ' + UNKNOWN_STREAK_THRESHOLD + ' daily check-ins didn\'t complete successfully — we couldn\'t confirm your testing status. Common causes include the hotline being unreachable, a phone-routing issue, or an expired or changed PIN.\n\nWhat to do:\n1. Call the hotline yourself to verify your status.\n2. If your PIN changed, update it at probationcall.com.\n3. Re-enable your schedule from the dashboard once things look right.\n\n- ProbationCall.com';
  await notify(notifyNumber, notifyEmail, notifyMethod, userMsg, 'unknown_streak').catch(function() {});
  // Admin alert
  var adminResult = await supabase.from('profiles').select('id').eq('is_admin', true);
  if (adminResult.data) {
    for (var a = 0; a < adminResult.data.length; a++) {
      var adminSched = await supabase.from('user_schedules').select('notify_number').eq('user_id', adminResult.data[a].id).single();
      if (adminSched.data && adminSched.data.notify_number) {
        await sendSMS(adminSched.data.notify_number,
          '⚠️ ADMIN: User ' + userId.slice(0, 8) + ' paused after ' + UNKNOWN_STREAK_THRESHOLD + ' no-result calls.\n\nLast: "' + String(lastReason || '').slice(0, 100) + '"',
          'unknown_streak').catch(function() {});
      }
    }
  }
}

// Track consecutive PIN_EXPIRED results. Auto-disables the schedule after
// PIN_EXPIRED_STREAK_THRESHOLD in a row (default 2) — a single occurrence
// could be a transient mishear; two in a row is a confident signal that
// the user's ID/PIN is no longer valid at the hotline.
//
// Notification policy: silent on the first PIN_EXPIRED; one SMS+email at
// auto-disable. Counter is reset by deductCreditOnce on any billable
// MUST_TEST/NO_TEST and by /api/schedule on PIN re-save.
var PIN_EXPIRED_STREAK_THRESHOLD = 2;
async function handlePinExpiredResult(userId, lastTranscript, notifyNumber, notifyEmail, notifyMethod) {
  var schedRes = await supabase.from('user_schedules')
    .select('consecutive_pin_expired, enabled')
    .eq('user_id', userId)
    .single();
  if (schedRes.error || !schedRes.data) return;
  var newCount = (schedRes.data.consecutive_pin_expired || 0) + 1;
  await supabase.from('user_schedules')
    .update({ consecutive_pin_expired: newCount })
    .eq('user_id', userId);
  console.log('[PIN-EXPIRED] User ' + userId.slice(0, 8) + ' consecutive count: ' + newCount + '/' + PIN_EXPIRED_STREAK_THRESHOLD);

  if (newCount < PIN_EXPIRED_STREAK_THRESHOLD) return;
  if (schedRes.data.enabled === false) {
    // Already disabled (e.g. via the UNKNOWN-streak path or manually). Don't re-notify.
    console.log('[PIN-EXPIRED] Schedule already disabled for ' + userId.slice(0, 8) + ' — skipping re-notify');
    return;
  }

  await supabase.from('user_schedules').update({ enabled: false }).eq('user_id', userId);
  if (scheduledJobs.has(userId)) {
    scheduledJobs.get(userId).stop();
    scheduledJobs.delete(userId);
  }
  console.log('[PIN-EXPIRED] Schedule auto-disabled for ' + userId.slice(0, 8));

  var userMsg = '⏸ ProbationCall paused\n\nThe hotline says your ID/PIN has expired, so we paused your daily check-ins to stop wasting credits.\n\nWhat to do:\n1. Verify directly with your probation officer or by calling the hotline yourself.\n2. Update your PIN at probationcall.com to resume calls.\n3. If your PIN is still valid and this looks wrong, contact us.\n\n- ProbationCall.com';
  await notify(notifyNumber, notifyEmail, notifyMethod, userMsg, 'pin_expired').catch(function() {});

  // Admin alert (one-shot at auto-disable).
  var adminResult = await supabase.from('profiles').select('id').eq('is_admin', true);
  if (adminResult.data) {
    for (var a = 0; a < adminResult.data.length; a++) {
      var adminSched = await supabase.from('user_schedules').select('notify_number').eq('user_id', adminResult.data[a].id).single();
      if (adminSched.data && adminSched.data.notify_number) {
        await sendSMS(adminSched.data.notify_number,
          '⚠️ ADMIN: User ' + userId.slice(0, 8) + ' auto-paused after ' + PIN_EXPIRED_STREAK_THRESHOLD + ' PIN_EXPIRED.\n\nLast heard: "' + String(lastTranscript || '').slice(0, 100) + '"',
          'pin_expired_admin').catch(function() {});
      }
    }
  }
}

// ========== AUTO-RETRY-ON-UNKNOWN (morning-aggregated retry) ==========
// Built-in retry sequence for the daily Montgomery scheduled call. When a
// scheduled-morning call resolves to a no-result outcome (UNKNOWN /
// CALL_FAILED / HOTLINE_DOWN), state is persisted to pending_retries and a
// per-minute cron poller fires the next attempt at the scheduled time.
// Exactly one call_history row is written per morning — either the
// resolving confirmed result, or the final no-result outcome after retries
// are exhausted or the 14:00 local cutoff is hit. Customer pays nothing
// for retries; credit is deducted only on confirmed MUST_TEST / NO_TEST.
//
// Out of scope: Fort Bend system call, manual /api/call, admin
// trigger-call. These set isScheduledMorning=false and keep single-shot
// behavior.
//
// PIN_EXPIRED is NEVER retried — own counter, handled by
// handlePinExpiredResult.

// Gaps between attempts: +5min after T0, +1hr after T1, +2hr after T2.
// 3 retries total (T1, T2, T3). T0 + 3 retries = 4 attempts max.
var RETRY_GAPS_MS = [5 * 60 * 1000, 60 * 60 * 1000, 2 * 60 * 60 * 1000];

// Format a UTC Date as YYYY-MM-DD in the given IANA timezone. Used for
// "is this row from today?" staleness checks across the date boundary.
function formatLocalDay(date, tz) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  var y = parts.find(function(p) { return p.type === 'year'; }).value;
  var m = parts.find(function(p) { return p.type === 'month'; }).value;
  var d = parts.find(function(p) { return p.type === 'day'; }).value;
  return y + '-' + m + '-' + d;
}

// Format today's date as M/D in the given TZ (no leading zeros). Used
// to date-stamp daily notification email subjects so Gmail doesn't bundle
// multiple days into one collapsed thread in the recipient's inbox.
function todayMD(tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Chicago',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date());
  var m = parts.find(function(p) { return p.type === 'month'; }).value;
  var d = parts.find(function(p) { return p.type === 'day'; }).value;
  return m + '/' + d;
}

// Would firing at `utcMoment` violate the "no attempt later than 2:00 PM
// local" cutoff? At minute precision: 14:00 OK, 14:01+ not OK.
function wouldExceedCutoff(utcMoment, tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric'
  }).formatToParts(utcMoment);
  var hour = parseInt(parts.find(function(p) { return p.type === 'hour'; }).value, 10);
  var minute = parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10);
  if (hour < 14) return false;
  if (hour > 14) return true;
  return minute > 0;
}

// Fort Bend cutoff: 9:30 AM CDT hard stop. Fort Bend hotlines close earlier
// than Montgomery (~10-11 AM); 9:30 leaves buffer for the cutoff path to
// notify users before lines close. At minute precision: 9:30 OK, 9:31+ NOT
// OK. Always called with America/Chicago — Fort Bend is single-county/TZ.
function wouldExceedFtbendCutoff(utcMoment, tz) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric'
  }).formatToParts(utcMoment);
  var hour = parseInt(parts.find(function(p) { return p.type === 'hour'; }).value, 10);
  var minute = parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10);
  if (hour < 9) return false;
  if (hour > 9) return true;
  return minute > 30;
}

// Given attempts_completed (1 = T0 done, 2 = T0+T1 done, ...), return the
// UTC Date when the NEXT attempt should fire, or null if exhausted.
function computeNextAttemptAt(attemptsCompleted) {
  if (attemptsCompleted >= RETRY_GAPS_MS.length + 1) return null;
  var gap = RETRY_GAPS_MS[attemptsCompleted - 1];
  return new Date(Date.now() + gap);
}

// Look up user's timezone. Fallback to America/Chicago if schedule is
// missing (e.g. user deleted schedule mid-morning before pending_retries
// cleanup ran).
async function getUserTimezone(userId) {
  var r = await supabase.from('user_schedules').select('timezone').eq('user_id', userId).maybeSingle();
  if (r.error || !r.data) return 'America/Chicago';
  return r.data.timezone || 'America/Chicago';
}

// Final-fail: write ONE call_history row for the morning, delete the
// pending_retries row, notify the user. Streak SELECT runs before the
// INSERT (race-safe, same pattern as d8bfe71).
async function finalFailMorning(state, existingRow) {
  var userId = state.user_id;
  var attemptsMade = state.attempt_number;

  // Streak check FIRST so its lookback SELECT doesn't race with our INSERT.
  await checkConsecutiveUnknown(userId, '(retry sequence exhausted after ' + attemptsMade + ' attempts — last: ' + state.last_result + ')', state.notify_number, state.notify_email, state.notify_method)
    .catch(function(e) { console.error('[UNKNOWN-STREAK] check failed:', e.message); });

  var row = {
    user_id: userId,
    call_sid: state.last_call_sid || 'unknown',
    target_number: state.target_number || '+19362834848',
    pin_used: state.pin,
    result: state.last_result,
    recording_url: state.last_recording_url,
    created_at: new Date().toISOString()
  };
  var insertResult = await supabase.from('call_history').insert(row);
  if (insertResult.error) {
    console.error('[RETRY] Final-fail call_history insert error for ' + userId.slice(0, 8) + ':', JSON.stringify(insertResult.error));
  } else {
    console.log('[RETRY] Final-fail recorded for ' + userId.slice(0, 8) + ' after ' + attemptsMade + ' attempts (last: ' + state.last_result + ')');
  }

  if (existingRow && existingRow.id) {
    await supabase.from('pending_retries').delete().eq('id', existingRow.id);
  } else {
    await supabase.from('pending_retries').delete().eq('user_id', userId);
  }

  var msg = '⚠️ Couldn\'t determine your status today\n\nWe tried calling the hotline ' + attemptsMade + ' times this morning but couldn\'t get a clear result. Please call the hotline yourself today to verify whether you need to test.\n\nYou were NOT charged a credit for these attempts.\n\n- ProbationCall.com';
  await notify(state.notify_number, state.notify_email, state.notify_method, msg, 'retry-final-fail').catch(function(e) {
    console.error('[RETRY] Failed to notify user of final-fail:', e.message);
  });
}

// Dispatcher: called from /webhook/recording (UNKNOWN, HOTLINE_DOWN) and
// /webhook/status (CALL_FAILED) when config.isScheduledMorning is true.
// Creates / updates the pending_retries row, OR triggers final-fail when
// retries are exhausted or the cutoff is hit. Never writes call_history
// directly (that's finalFailMorning's job or the success path's job).
async function handleScheduledMorningNoResult(config, result, callSid, transcript, recordingUrl) {
  if (!config.userId) return;

  var existing = await supabase.from('pending_retries').select('*').eq('user_id', config.userId).maybeSingle();
  var row = existing.data || null;

  // Determine TZ — from the row if present, else look up the schedule.
  var tz;
  if (row) {
    tz = await getUserTimezone(config.userId);
    // Stale-row detection: row from a prior day (in user's TZ) is a leak.
    var rowDay = formatLocalDay(new Date(row.created_at), tz);
    var todayDay = formatLocalDay(new Date(), tz);
    if (rowDay !== todayDay) {
      console.log('[RETRY] Cleaning stale pending_retries row from ' + rowDay + ' for user ' + config.userId.slice(0, 8));
      await supabase.from('pending_retries').delete().eq('id', row.id);
      row = null;
    }
  } else {
    tz = await getUserTimezone(config.userId);
  }

  var attemptsCompleted = row ? row.attempt_number + 1 : 1;
  var nextAt = computeNextAttemptAt(attemptsCompleted);

  if (nextAt === null || wouldExceedCutoff(nextAt, tz)) {
    console.log('[RETRY] ' + (nextAt === null ? 'Exhausted' : 'Cutoff would be exceeded') + ' for ' + config.userId.slice(0, 8) + ' after ' + attemptsCompleted + ' attempts — final-fail');
    await finalFailMorning({
      user_id: config.userId,
      county: (row && row.county) || config.county || 'montgomery',
      target_number: config.targetNumber || (row && row.target_number),
      pin: config.pin || (row && row.pin),
      notify_number: config.notifyNumber || (row && row.notify_number),
      notify_email: config.notifyEmail || (row && row.notify_email),
      notify_method: config.notifyMethod || (row && row.notify_method),
      attempt_number: attemptsCompleted,
      last_result: result,
      last_call_sid: callSid,
      last_transcript: transcript,
      last_recording_url: recordingUrl
    }, row);
    return;
  }

  if (row) {
    var upd = await supabase.from('pending_retries').update({
      attempt_number: attemptsCompleted,
      last_result: result,
      last_call_sid: callSid,
      last_transcript: transcript,
      last_recording_url: recordingUrl,
      next_attempt_at: nextAt.toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', row.id);
    if (upd.error) {
      console.error('[RETRY] Failed to update pending_retries for ' + config.userId.slice(0, 8) + ':', upd.error.message);
      return;
    }
    console.log('[RETRY] Queued attempt ' + (attemptsCompleted + 1) + ' for ' + config.userId.slice(0, 8) + ' at ' + nextAt.toISOString() + ' (after ' + result + ')');
  } else {
    var ins = await supabase.from('pending_retries').insert({
      user_id: config.userId,
      county: config.county || 'montgomery',
      target_number: config.targetNumber,
      pin: config.pin,
      notify_number: config.notifyNumber,
      notify_email: config.notifyEmail,
      notify_method: config.notifyMethod,
      attempt_number: attemptsCompleted,
      last_result: result,
      last_call_sid: callSid,
      last_transcript: transcript,
      last_recording_url: recordingUrl,
      next_attempt_at: nextAt.toISOString()
    });
    if (ins.error) {
      console.error('[RETRY] Failed to insert pending_retries for ' + config.userId.slice(0, 8) + ':', ins.error.message);
      return;
    }
    console.log('[RETRY] Queued first retry for ' + config.userId.slice(0, 8) + ' at ' + nextAt.toISOString() + ' (after ' + result + ')');
  }
}

function isDev(email) {
  return DEV_EMAILS.includes(email.toLowerCase());
}

function generateReferralCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function log(callId, msg, type) {
  console.log('[' + (callId || 'SYS') + '] ' + msg);
  broadcastToClients({ type: 'log', callId: callId, log: { message: msg, type: type || 'info' } });
}

function broadcastToClients(data) {
  // If the event references a callId we know about, send only to the socket
  // owned by that call's userId. Otherwise (no callId or unknown call) the
  // event is dropped — we don't broadcast call data across users.
  var targetUserId = null;
  if (data && data.callId) {
    var pc = pendingCalls.get(data.callId);
    if (pc && pc.userId) targetUserId = pc.userId;
  }
  if (!targetUserId) return;
  wsClients.forEach(function(c) {
    if (c.readyState === WebSocket.OPEN && c.userId === targetUserId) {
      c.send(JSON.stringify(data));
    }
  });
}

// Generate consistent random delay based on user ID (same user = same delay each day)
function getStaggerDelay(userId) {
  var hash = 0;
  for (var i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash;
  }
  // Convert to 0 to STAGGER_MINUTES range (in milliseconds)
  var delayMs = Math.abs(hash % (STAGGER_MINUTES * 60 * 1000));
  return delayMs;
}

// Simple per-user in-memory rate limit. Keyed on userId + bucket name.
// Used to stop a signed-in user from burning Twilio/Stripe quota.
var _rateBuckets = new Map();
function rateLimit(bucket, max, windowMs) {
  return function(req, res, next) {
    var key = bucket + ':' + (req.user ? req.user.id : (req.ip || 'anon'));
    var now = Date.now();
    var entry = _rateBuckets.get(key);
    if (!entry || (now - entry.windowStart) > windowMs) {
      _rateBuckets.set(key, { windowStart: now, count: 1 });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      var retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Try again in ' + retryAfter + 's.' });
    }
    next();
  };
}

async function auth(req, res, next) {
  var authHeader = req.headers.authorization;
  var token = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    var result = await supabase.auth.getUser(token);
    if (result.error || !result.data.user) return res.status(401).json({ error: 'Invalid token' });
    
    var user = result.data.user;
    var profileResult = await supabase.from('profiles').select('*').eq('id', user.id).single();
    var profile = profileResult.data;
    
    if (!profile) {
      var referralCode = generateReferralCode();
      var startCredits = isDev(user.email) ? 9999 : 5;
      // Insert with 0 credits, then grant via the ledger RPC so the signup
      // bonus shows up in the audit trail.
      await supabase.from('profiles').insert({
        id: user.id,
        email: user.email,
        credits: 0,
        referral_code: referralCode,
        affiliate_balance_cents: 0,
        affiliate_total_earned_cents: 0
      });
      await recordCreditAdd({
        userId: user.id,
        amount: startCredits,
        source: 'signup_bonus',
        note: isDev(user.email) ? 'Dev account starting credits' : 'New user starter credits'
      });
      profile = { id: user.id, email: user.email, credits: startCredits, referral_code: referralCode };
      // Send welcome email to new user
      sendWelcomeEmail(user.email, startCredits, 'welcome').catch(function(e) { console.log('[WELCOME] Email failed:', e.message); });
    }
    
    // Generate referral code if user doesn't have one
    if (!profile.referral_code) {
      var newCode = generateReferralCode();
      await supabase.from('profiles').update({ referral_code: newCode }).eq('id', user.id);
      profile.referral_code = newCode;
    }
    
    if (isDev(user.email)) {
      profile.credits = 9999;
      profile.isDev = true;
    }
    
    req.user = user;
    req.profile = profile;
    // Track last login
    supabase.from('profiles').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    next();
  } catch(e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Auth error' });
  }
}

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/dashboard', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/health', function(req, res) { res.json({ status: 'ok', scheduledJobs: scheduledJobs.size, activeConnections: wsClients.size }); });

// Referral landing page
app.get('/r/:code', function(req, res) {
  res.redirect('/?ref=' + req.params.code);
});

app.get('/api/user', auth, async function(req, res) {
  var historyResult = await supabase.from('call_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(500);
  var scheduleResult = await supabase.from('user_schedules').select('*').eq('user_id', req.user.id).single();
  
  // Get referral stats
  var referralResult = await supabase.from('referrals').select('*').eq('referrer_id', req.user.id);
  var referrals = referralResult.data || [];
  
  // Get earnings history
  var earningsResult = await supabase.from('affiliate_earnings').select('*').eq('affiliate_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  
  // Get payout history
  var payoutsResult = await supabase.from('payout_requests').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(10);
  
  res.json({
    user: req.user,
    profile: req.profile,
    // Top-level flag the dashboard checks to gate the affiliate tab + UI.
    // When false, the client hides the Earn Cash tab and skips any
    // auto-apply of a saved referral code from localStorage.
    affiliateEnabled: AFFILIATE_ENABLED,
    probationEndDate: req.profile.probation_end_date,
    userColor: req.profile.user_color,
    onboardingComplete: req.profile.onboarding_complete,
    ftbend_access: req.profile.ftbend_access || false,
    history: historyResult.data || [], 
    schedule: scheduleResult.data,
    isDev: isDev(req.user.email),
    affiliate: {
      referralCode: req.profile.referral_code,
      balance: req.profile.affiliate_balance_cents || 0,
      totalEarned: req.profile.affiliate_total_earned_cents || 0,
      minPayout: MIN_PAYOUT_CENTS,
      commissionPercent: AFFILIATE_COMMISSION_PERCENT,
      referrals: referrals,
      earnings: earningsResult.data || [],
      payouts: payoutsResult.data || [],
      payoutEmail: req.profile.payout_email
    }
  });
});

// Global Montgomery Test Analytics (for learning patterns)
app.get("/api/admin/montgomery-analytics", adminAuth, async function(req, res) {
  try {
    var result = await supabase.from("call_history").select("*").eq("result", "MUST_TEST").order("created_at", { ascending: true });
    if (result.error) return res.status(500).json({ error: result.error.message });
    var tests = result.data || [];
    if (tests.length < 5) return res.json({ error: "Not enough data", totalTests: tests.length });
    
    // Calculate system-wide interval
    var userTests = {};
    tests.forEach(function(t) {
      if (!userTests[t.user_id]) userTests[t.user_id] = [];
      userTests[t.user_id].push(new Date(t.created_at));
    });
    
    var allIntervals = [];
    Object.keys(userTests).forEach(function(uid) {
      var dates = userTests[uid].sort(function(a,b) { return a-b; });
      for (var i = 1; i < dates.length; i++) {
        var days = Math.round((dates[i] - dates[i-1]) / (1000*60*60*24));
        if (days > 0 && days < 60) allIntervals.push(days);
      }
    });
    
    var avgSystemInterval = allIntervals.length > 0 ? (allIntervals.reduce(function(a,b){return a+b},0) / allIntervals.length) : 0;
    var medianInterval = allIntervals.sort(function(a,b){return a-b})[Math.floor(allIntervals.length/2)] || 0;
    
    // Day of week analysis
    var dayCount = [0,0,0,0,0,0,0];
    var dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    tests.forEach(function(t) { dayCount[new Date(t.created_at).getDay()]++; });
    var maxDay = Math.max.apply(null, dayCount);
    var dayPatterns = dayNames.map(function(name, i) {
      return { day: name, count: dayCount[i], pct: ((dayCount[i]/tests.length)*100).toFixed(1), likelihood: dayCount[i] >= maxDay*0.7 ? "high" : dayCount[i] >= maxDay*0.3 ? "medium" : "low" };
    });
    
    // Day of month analysis
    var domCount = {};
    tests.forEach(function(t) {
      var dom = new Date(t.created_at).getDate();
      domCount[dom] = (domCount[dom] || 0) + 1;
    });
    var domPatterns = Object.keys(domCount).map(function(d) { return { day: parseInt(d), count: domCount[d] }; }).sort(function(a,b) { return b.count - a.count; });
    
    // Week of month analysis
    var weekCount = [0,0,0,0,0];
    tests.forEach(function(t) {
      var dom = new Date(t.created_at).getDate();
      var week = Math.min(4, Math.floor((dom-1)/7));
      weekCount[week]++;
    });
    var weekLabels = ["Week 1 (1-7)","Week 2 (8-14)","Week 3 (15-21)","Week 4 (22-28)","Week 5 (29-31)"];
    var weekPatterns = weekLabels.map(function(label, i) { return { week: label, count: weekCount[i], pct: ((weekCount[i]/tests.length)*100).toFixed(1) }; });
    
    // Consecutive test analysis
    var consecutiveCount = 0;
    var userConsec = {};
    Object.keys(userTests).forEach(function(uid) {
      var dates = userTests[uid].sort(function(a,b){return a-b});
      for (var i = 1; i < dates.length; i++) {
        var days = Math.round((dates[i] - dates[i-1]) / (1000*60*60*24));
        if (days <= 2) consecutiveCount++;
      }
    });
    var consecPct = allIntervals.length > 0 ? ((consecutiveCount/allIntervals.length)*100).toFixed(1) : 0;
    
    // Interval distribution
    var intervalDist = {};
    allIntervals.forEach(function(i) { intervalDist[i] = (intervalDist[i] || 0) + 1; });
    var topIntervals = Object.keys(intervalDist).map(function(i) { return { days: parseInt(i), count: intervalDist[i] }; }).sort(function(a,b) { return b.count - a.count; }).slice(0, 10);
    
    res.json({
      totalTests: tests.length,
      totalUsers: Object.keys(userTests).length,
      avgSystemInterval: avgSystemInterval.toFixed(1),
      medianInterval: medianInterval,
      dayPatterns: dayPatterns,
      weekPatterns: weekPatterns,
      topDaysOfMonth: domPatterns.slice(0, 10),
      consecutiveTestPct: consecPct,
      topIntervals: topIntervals,
      confidence: Math.min(95, 50 + tests.length)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/system-stats', auth, async function(req, res) {
  try {
    var now = Date.now();
    if (global.systemStatsCache && (now - global.systemStatsCache.timestamp) < 3600000) {
      return res.json(global.systemStatsCache.data);
    }
    var result = await supabase.from('call_history').select('user_id, created_at, result, county')
      .eq('result', 'MUST_TEST').order('created_at', { ascending: true });
    if (result.error) return res.status(500).json({ error: result.error.message });
    var tests = (result.data || []).filter(function(t) {
      var c = t.county || 'montgomery';
      return c === 'montgomery' || c.indexOf('montgomery') === 0;
    });
    var userTests = {};
    tests.forEach(function(t) {
      if (!userTests[t.user_id]) userTests[t.user_id] = [];
      userTests[t.user_id].push(t.created_at);
    });
    var scheduledIntervals = [], retestIntervals = [];
    Object.keys(userTests).forEach(function(uid) {
      var dates = userTests[uid].map(function(d) { return new Date(d); }).sort(function(a,b) { return a-b; });
      for (var i = 1; i < dates.length; i++) {
        var days = Math.round((dates[i]-dates[i-1])/(1000*60*60*24));
        if (days <= 0) continue;
        if (days < 7) retestIntervals.push(days);
        else if (days < 60) scheduledIntervals.push(days);
      }
    });
    var scheduledAvg = 0, scheduledMedian = 0, scheduledStdDev = 0;
    if (scheduledIntervals.length > 0) {
      scheduledAvg = scheduledIntervals.reduce(function(a,b){return a+b},0) / scheduledIntervals.length;
      var sorted = scheduledIntervals.slice().sort(function(a,b){return a-b});
      scheduledMedian = sorted[Math.floor(sorted.length/2)];
      var variance = scheduledIntervals.reduce(function(s,v){return s+Math.pow(v-scheduledAvg,2)},0) / scheduledIntervals.length;
      scheduledStdDev = Math.sqrt(variance);
    }
    var dateCounts = {};
    tests.forEach(function(t) {
      var date = t.created_at.substring(0,10);
      if (!dateCounts[date]) dateCounts[date] = [];
      if (dateCounts[date].indexOf(t.user_id) === -1) dateCounts[date].push(t.user_id);
    });
    var confirmedTestingDays = Object.keys(dateCounts).filter(function(d){return dateCounts[d].length >= 2;}).sort();
    var dayCount = [0,0,0,0,0,0,0];
    tests.forEach(function(t) { dayCount[new Date(t.created_at).getDay()]++; });
    var data = {
      scheduledAvg: parseFloat(scheduledAvg.toFixed(1)),
      scheduledMedian: scheduledMedian,
      scheduledStdDev: parseFloat(scheduledStdDev.toFixed(1)),
      scheduledIntervalCount: scheduledIntervals.length,
      retestCount: retestIntervals.length,
      totalMustTestEvents: tests.length,
      totalUsersWithTests: Object.keys(userTests).length,
      confirmedTestingDays: confirmedTestingDays.slice(-60),
      dayOfWeekCounts: dayCount,
      generatedAt: new Date().toISOString()
    };
    global.systemStatsCache = { timestamp: now, data: data };
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Fort Bend Color Analytics
app.get("/api/ftbend/analytics", auth, async function(req, res) {
  try {
    var result = await supabase.from("daily_county_status").select("*").order("date", { ascending: false }).limit(365);
    if (result.error) return res.status(500).json({ error: result.error.message });
    var data = result.data || [];
    var colorCounts = {};
    var dayOfWeekCounts = {};
    var officeColors = { missouri: {}, rosenberg: {}, rosenberg2: {} };
    var recentColors = { missouri: [], rosenberg: [], rosenberg2: [] };
    var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    data.forEach(function(r) {
      if (!r.color) return;
      var color = r.color.toLowerCase();
      colorCounts[color] = (colorCounts[color] || 0) + 1;
      var dow = new Date(r.date).getDay();
      if (!dayOfWeekCounts[dow]) dayOfWeekCounts[dow] = {};
      dayOfWeekCounts[dow][color] = (dayOfWeekCounts[dow][color] || 0) + 1;
      var office = r.county ? r.county.replace("ftbend_", "") : "missouri";
      if (officeColors[office]) {
        officeColors[office][color] = (officeColors[office][color] || 0) + 1;
        if (recentColors[office].length < 30) recentColors[office].push({ date: r.date, color: r.color });
      }
    });
    var sortedColors = Object.keys(colorCounts).sort(function(a, b) { return colorCounts[b] - colorCounts[a]; });
    var topColors = sortedColors.slice(0, 15).map(function(c) { return { color: c, count: colorCounts[c], pct: ((colorCounts[c] / data.length) * 100).toFixed(1) }; });
    var dayPatterns = {};
    for (var d = 0; d < 7; d++) {
      if (dayOfWeekCounts[d]) {
        var sorted = Object.keys(dayOfWeekCounts[d]).sort(function(a, b) { return dayOfWeekCounts[d][b] - dayOfWeekCounts[d][a]; });
        dayPatterns[dayNames[d]] = sorted.slice(0, 5).map(function(c) { return { color: c, count: dayOfWeekCounts[d][c] }; });
      }
    }
    var lastCalled = {};
    data.forEach(function(r) {
      if (r.color && !lastCalled[r.color.toLowerCase()]) lastCalled[r.color.toLowerCase()] = r.date;
    });
    var predictions = sortedColors.slice(0, 20).map(function(c) {
      var lastDate = lastCalled[c];
      var daysSince = lastDate ? Math.round((new Date() - new Date(lastDate)) / (1000 * 60 * 60 * 24)) : 999;
      var avgInterval = data.length > 0 ? Math.round(data.length / (colorCounts[c] || 1)) : 0;
      return { color: c, count: colorCounts[c], daysSince: daysSince, avgInterval: avgInterval, likelihood: daysSince >= avgInterval ? "high" : daysSince >= avgInterval * 0.7 ? "medium" : "low" };
    });
    res.json({ totalRecords: data.length, topColors: topColors, dayPatterns: dayPatterns, predictions: predictions, recentColors: recentColors, officeColors: officeColors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply referral code (called during signup or first visit)
app.post('/api/apply-referral', auth, requireAffiliateEnabled, async function(req, res) {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  
  // Check if user already used a referral
  if (req.profile.referred_by) {
    return res.status(400).json({ error: 'You already used a referral code' });
  }
  
  // Find referrer — shared safe resolver handles uppercasing + dup detection.
  var referrer = await resolveAffiliateByCode(code);
  if (!referrer) {
    return res.status(404).json({ error: 'Invalid referral code' });
  }

  // Can't refer yourself
  if (referrer.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot use your own referral code' });
  }
  
  // Set the referral lock first, then grant the bonus via the ledger so it
  // shows up in credit history. Two writes, but the lock is an attribute
  // unrelated to credits — splitting is cleaner than smuggling both through
  // the RPC.
  await supabase.from('profiles').update({
    referred_by: code.toUpperCase()
  }).eq('id', req.user.id);
  await recordCreditAdd({
    userId: req.user.id,
    amount: REFERRED_BONUS_CREDITS,
    source: 'referral_bonus',
    note: 'Referral signup bonus (code ' + code.toUpperCase() + ')'
  });
  
  // Create referral record
  await supabase.from('referrals').insert({
    referrer_id: referrer.id,
    referred_id: req.user.id,
    referral_code: code.toUpperCase(),
    status: 'signed_up'
  });
  
  console.log('[AFFILIATE] User ' + req.user.email + ' signed up with code ' + code);
  
  res.json({ success: true, bonusCredits: REFERRED_BONUS_CREDITS });
});

// Set payout email
app.post('/api/affiliate/payout-email', auth, requireAffiliateEnabled, async function(req, res) {
  var email = req.body.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  await supabase.from('profiles').update({ payout_email: email }).eq('id', req.user.id);
  res.json({ success: true });
});

// Request payout
app.post('/api/affiliate/request-payout', auth, requireAffiliateEnabled, async function(req, res) {
  // FIX (AFFILIATE_AUDIT §6.A — double-pay hole):
  // Connect affiliates are paid automatically via stripe.transfers.create on
  // each commission. Letting them ALSO request a manual PayPal payout from
  // here would double-pay them. Reject with a clear explanation. The webhook
  // commission block doesn't credit affiliate_balance_cents for Connect
  // affiliates anyway, so this check is the second line of defense (in case
  // a profile somehow has both stripe_connect_id AND a stale balance from
  // before this fix was deployed).
  if (req.profile.stripe_connect_id) {
    return res.status(400).json({
      error: 'Your earnings are paid directly to your bank via Stripe Connect; no manual payout needed.'
    });
  }

  var balance = req.profile.affiliate_balance_cents || 0;
  var payoutEmail = req.profile.payout_email;
  var method = req.body.method || 'paypal';

  if (!payoutEmail) {
    return res.status(400).json({ error: 'Please set your PayPal email first' });
  }

  if (balance < MIN_PAYOUT_CENTS) {
    return res.status(400).json({ error: 'Minimum payout is $' + (MIN_PAYOUT_CENTS / 100).toFixed(2) });
  }
  
  // Check for pending payout
  var pendingResult = await supabase.from('payout_requests').select('id').eq('user_id', req.user.id).eq('status', 'pending').single();
  if (pendingResult.data) {
    return res.status(400).json({ error: 'You already have a pending payout request' });
  }

  // Create payout request FIRST. Only zero the balance if the insert succeeded —
  // otherwise the user has an empty balance and no pending payout to show for it.
  var insertResult = await supabase.from('payout_requests').insert({
    user_id: req.user.id,
    amount_cents: balance,
    payout_email: payoutEmail,
    payout_method: method,
    status: 'pending'
  });
  if (insertResult.error) {
    console.error('[PAYOUT] Insert failed for', req.user.id.slice(0, 8), ':', insertResult.error);
    return res.status(500).json({ error: 'Could not create payout request' });
  }

  var zeroResult = await supabase.from('profiles').update({ affiliate_balance_cents: 0 }).eq('id', req.user.id);
  if (zeroResult.error) {
    // Roll back the payout request so user can retry — avoid double-paying.
    console.error('[PAYOUT] Balance zero failed for', req.user.id.slice(0, 8), '— rolling back payout request:', zeroResult.error);
    await supabase.from('payout_requests')
      .delete()
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .eq('amount_cents', balance);
    return res.status(500).json({ error: 'Could not finalize payout — please try again' });
  }
  
  // Notify you (the owner) about payout request
  if (process.env.BREVO_KEY) {
    await brevoMail.send({
      to: 'whatnissan@gmail.com',
      from: FROM_EMAIL,
      subject: '💰 New Payout Request - ProbationCall',
      text: 'New payout request:\n\nUser: ' + req.user.email + '\nAmount: $' + (balance / 100).toFixed(2) + '\nPayPal: ' + payoutEmail
    });
  }
  
  console.log('[AFFILIATE] Payout requested: $' + (balance / 100).toFixed(2) + ' to ' + payoutEmail);
  
  res.json({ success: true, amount: balance });
});

app.post("/api/accept-terms", auth, async function(req, res) { 
  try { 
    var result = await supabase.from("profiles").update({ terms_accepted_at: new Date().toISOString() }).eq("id", req.user.id);
    if (result.error) {
      console.error('[TERMS] Error:', result.error);
      return res.status(500).json({ error: result.error.message }); 
    }
    res.json({ success: true }); 
  } catch (e) { 
    console.error('[TERMS] Exception:', e);
    res.status(500).json({ error: e.message }); 
  } 
});

app.post('/api/redeem', auth, async function(req, res) {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: 'No code' });
  
  var promoResult = await supabase.from('promo_codes').select('*').eq('code', code.toUpperCase()).single();
  var promo = promoResult.data;
  if (!promo) return res.status(404).json({ error: 'Invalid code' });
  if (promo.times_used >= promo.max_uses) return res.status(400).json({ error: 'Code expired' });
  
  var existingResult = await supabase.from('promo_redemptions').select('*').eq('user_id', req.user.id).eq('promo_code_id', promo.id).single();
  if (existingResult.data) return res.status(400).json({ error: 'Already used' });
  
  await supabase.from('promo_redemptions').insert({ user_id: req.user.id, promo_code_id: promo.id });
  await supabase.from('promo_codes').update({ times_used: promo.times_used + 1 }).eq('id', promo.id);
  await recordCreditAdd({
    userId: req.user.id,
    amount: promo.credits,
    source: 'promo',
    note: 'Promo code: ' + code.toUpperCase()
  });
  
  res.json({ success: true, credits: promo.credits });
});

// Check if affiliate code is valid
app.post('/api/check-affiliate-code', auth, requireAffiliateEnabled, async function(req, res) {
  var code = req.body.code ? req.body.code.toUpperCase() : '';
  // Shared resolver — also handles the duplicate-code defense even though
  // this endpoint isn't itself a money path. Consistent behavior across
  // every resolver call site.
  var match = await resolveAffiliateByCode(code);
  if (match) {
    res.json({ valid: true, code: code });
  } else {
    res.json({ valid: false });
  }
});

// Stripe Connect - Create onboarding link for affiliates
app.post('/api/affiliate/connect', auth, requireAffiliateEnabled, async function(req, res) {
  try {
    // Check if user already has a connected account
    if (req.profile.stripe_connect_id) {
      // Create login link for existing account
      var loginLink = await stripe.accounts.createLoginLink(req.profile.stripe_connect_id);
      return res.json({ url: loginLink.url });
    }
    
    // Create new connected account
    var account = await stripe.accounts.create({
      type: 'standard',
      email: req.user.email,
      metadata: { user_id: req.user.id }
    });
    
    // Save the account ID
    await supabase.from('profiles')
      .update({ stripe_connect_id: account.id })
      .eq('id', req.user.id);
    
    // Create onboarding link
    var accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: process.env.BASE_URL + '/dashboard?connect=refresh',
      return_url: process.env.BASE_URL + '/dashboard?connect=success',
      type: 'account_onboarding'
    });
    
    console.log('[CONNECT] Created account for ' + req.user.email + ': ' + account.id);
    res.json({ url: accountLink.url });
  } catch (e) {
    console.error('[CONNECT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Check Stripe Connect status
app.get('/api/affiliate/connect-status', auth, requireAffiliateEnabled, async function(req, res) {
  if (!req.profile.stripe_connect_id) {
    return res.json({ connected: false });
  }
  
  try {
    var account = await stripe.accounts.retrieve(req.profile.stripe_connect_id);
    res.json({ 
      connected: true, 
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      account_id: account.id
    });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

app.post('/api/schedule', auth, async function(req, res) {
  var hour = parseInt(req.body.hour) || 6;
  var minute = parseInt(req.body.minute) || 0;
  
  var county = req.body.county || 'montgomery';
  
  // Fort Bend has different time restrictions
  if (county !== 'ftbend' && (hour < MIN_HOUR || hour > MAX_HOUR || (hour === MAX_HOUR && minute > 59))) {
    return res.status(400).json({ error: 'Schedule time must be between 6:00 AM and 2:59 PM' });
  }
  
  var data = {
    user_id: req.user.id,
    county: req.body.county || 'montgomery',
    target_number: getCountyConfig(req.body.county || 'montgomery').number,
    pin: req.body.pin,
    notify_number: formatPhone(req.body.notifyNumber),
    notify_email: req.body.notifyEmail || null,
    notify_method: req.body.notifyMethod || 'email',
    hour: hour,
    minute: minute,
    timezone: req.body.timezone || 'America/Chicago',
    quiet_mode: req.body.quietMode || false,
    ftbend_office: req.body.ftbend_office || 'missouri',
    enabled: true,
    // Re-saving the schedule (typically to update a fresh PIN) clears the
    // PIN_EXPIRED streak so the auto-disable logic starts over.
    consecutive_pin_expired: 0
  };
  
  var existingResult = await supabase.from('user_schedules').select('id').eq('user_id', req.user.id).single();
  
  var result;
  if (existingResult.data) {
    result = await supabase.from('user_schedules').update(data).eq('user_id', req.user.id);
  } else {
    result = await supabase.from('user_schedules').insert(data);
    // Send welcome SMS on first schedule setup
    if (data.notify_number) {
      sendSMS(data.notify_number, '🎉 Welcome to ProbationCall!\n\nYour daily check-in is now active. We\'ll call the hotline for you every day and text you the results.\n\nManage your account anytime at:\nprobationcall.com\n\n- ProbationCall.com', 'welcome').catch(function(e) { console.log('[WELCOME] SMS failed:', e.message); });
    }
  }
  
  if (result.error) {
    console.error('[SCHEDULE] Error:', result.error);
    return res.status(500).json({ error: result.error.message || 'Database error' });
  }

  // Persistent "this user is Fort Bend" memory. Set ftbend_access=true so
  // the Ft Bend tab stays visible and the County dropdown defaults to Ft
  // Bend even after the NO_CREDITS path (server.js ~line 4226) auto-deletes
  // the user_schedules row. Only flips false->true; we don't unset on
  // county switch since revoking tab access would be a UX surprise.
  if (county === 'ftbend') {
    await supabase.from('profiles').update({ ftbend_access: true }).eq('id', req.user.id).then(function() {}, function(e) {
      console.error('[SCHEDULE] Failed to set ftbend_access for ' + req.user.id.slice(0, 8) + ':', e.message);
    });
  }

  rescheduleUser(req.user.id, data);
  res.json({ success: true });
});

app.delete('/api/schedule', auth, async function(req, res) {
  await supabase.from('user_schedules').delete().eq('user_id', req.user.id);
  if (scheduledJobs.has(req.user.id)) {
    scheduledJobs.get(req.user.id).stop();
    scheduledJobs.delete(req.user.id);
  }
  await supabase.from('pending_retries').delete().eq('user_id', req.user.id).then(function() {}, function(e) {
    console.error('[RETRY] Failed to clean pending_retries on schedule delete:', e.message);
  });
  res.json({ success: true });
});

function rescheduleUser(userId, sched) {
  if (scheduledJobs.has(userId)) {
    scheduledJobs.get(userId).stop();
    scheduledJobs.delete(userId);
  }
  if (!sched.enabled) return;
  
  // Ft Bend users don't get individual calls - they get notified by the 5:05 AM system call
  if (sched.county === 'ftbend') {
    console.log('[SCHED] User ' + userId.slice(0,8) + '... is Ft Bend - will be notified by system call');
    return;
  }
  
  var expr = sched.minute + ' ' + sched.hour + ' * * *';
  var staggerDelay = getStaggerDelay(userId);
  var staggerMinutes = Math.floor(staggerDelay / 60000);
  var staggerSeconds = Math.floor((staggerDelay % 60000) / 1000);
  
  console.log('[SCHED] User ' + userId.slice(0,8) + '...: ' + expr + ' ' + sched.timezone +
    ' (stagger: +' + staggerMinutes + 'm ' + staggerSeconds + 's)');
  
  var job = cron.schedule(expr, async function() {
    // Apply stagger delay to spread out calls
    setTimeout(async function() {
      console.log('[SCHED] Running for ' + userId.slice(0,8) + '... (after ' + staggerMinutes + 'm stagger)');
      try {
        var profileResult = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
        var profile = profileResult.data;
        
        if (!profile) return;
        
        var isDevUser = isDev(profile.email);
        
        if (!isDevUser && profile.credits < 1) {
          var skipCount = (sched.no_credit_skip_count || 0) + 1;
          if (skipCount >= 2) {
            await supabase.from('user_schedules').delete().eq('user_id', userId);
            if (scheduledJobs.has(userId)) { scheduledJobs.get(userId).stop(); scheduledJobs.delete(userId); }
            await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ Schedule Removed\n\nYour daily check-ins have stopped due to no credits remaining.\n\nPurchase credits and set up your schedule again at:\nprobationcall.com\n\n- ProbationCall.com', 'sched');
          } else {
            await supabase.from('user_schedules').update({ no_credit_skip_count: skipCount }).eq('user_id', userId);
            await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ Call Skipped - Low Credits\n\nToday\'s check-in was skipped because you\'re out of credits. Your schedule will be removed tomorrow if credits are not added.\n\nPurchase credits now at:\nprobationcall.com\n\n- ProbationCall.com', 'sched');
          }

          return;
        }
        
        // Credit is deducted in /webhook/recording once a result (MUST_TEST
        // or NO_TEST) is known. UNKNOWN does not bill. See deductCreditOnce.
        // isScheduledMorning=true → if this call returns a no-result outcome,
        // it enters the auto-retry sequence (handleScheduledMorningNoResult).
        await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_email, sched.notify_method, userId, 0, undefined, true);
      } catch (e) {
        // This catches a pre-flight throw from initiateCall (e.g. Twilio
        // SDK rejected the request before a call_sid was assigned). No
        // call_history row was written, so the :45 missed-call recovery
        // cron WILL retry automatically at the next :45 mark this morning.
        // Message reflects that — don't promise "shortly" since the retry
        // is at most ~60 min away and is not guaranteed (recovery itself
        // can also fail). Tells the user to verify manually if they don't
        // hear back, which is the right action.
        console.error('[SCHED] Error for ' + userId.slice(0,8) + '...:', e.message);
        await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ Call Issue\n\nYour scheduled check-in couldn\'t be completed this morning. Our system will automatically attempt a recovery call within the next hour.\n\nIf you don\'t hear back from us by mid-morning, please call the hotline yourself to verify your status.\n\n- ProbationCall.com', 'sched');
      }
    }, staggerDelay);
  }, { timezone: sched.timezone });
  
  scheduledJobs.set(userId, job);
}

async function loadAllSchedules() {
  var result = await supabase.from('user_schedules').select('*').eq('enabled', true);
  if (result.data && result.data.length > 0) {
    result.data.forEach(function(s) { rescheduleUser(s.user_id, s); });
    console.log('[SCHED] Loaded ' + result.data.length + ' schedules (staggered over ' + STAGGER_MINUTES + ' minutes)');
  }
}

// === SUBSCRIPTION SUPPORT ===
// All subscription handlers below intentionally DO NOT touch affiliate /
// commission code. Affiliate program is off for subscriptions per policy.
const SUBSCRIPTION_CREDITS_PER_PAYMENT = 30;

// Locate the profile that owns a subscription. Prefer subscription metadata
// (set at Checkout creation time so it's stable across renewals); fall back
// to a stripe_customer_id lookup if metadata is missing.
async function findUserForSubscription(subscriptionId, customerId) {
  if (subscriptionId) {
    try {
      var sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (sub && sub.metadata && sub.metadata.user_id) {
        var pr = await supabase.from('profiles').select('*').eq('id', sub.metadata.user_id).single();
        if (pr.data) return pr.data;
      }
    } catch (e) {
      console.error('[STRIPE WEBHOOK] Failed to retrieve subscription', subscriptionId, ':', e.message);
    }
  }
  if (customerId) {
    var cr = await supabase.from('profiles').select('*').eq('stripe_customer_id', customerId).single();
    if (cr.data) return cr.data;
  }
  return null;
}

// Subscription Checkout completed: capture customer + sub IDs on the profile.
// Credits are NOT granted here — they come via invoice.paid (which fires for
// the first payment too, so the credit grant is one consistent path).
async function handleSubscriptionCheckoutCompleted(s, res) {
  try {
    var userId = s.metadata && s.metadata.user_id;
    if (!userId) {
      console.error('[STRIPE WEBHOOK] Subscription session missing user_id metadata, session:', s.id);
      return res.json({ received: true, error: 'missing_user_id' });
    }
    var upd = await supabase.from('profiles').update({
      stripe_customer_id: s.customer,
      stripe_subscription_id: s.subscription,
      subscription_status: 'active',
      // A brand-new subscription is never in "canceling" state — clear any
      // residual cancel fields left over from a previous, terminated sub.
      subscription_cancel_at_period_end: false,
      subscription_cancel_at: null
    }).eq('id', userId);
    if (upd.error) {
      console.error('[STRIPE WEBHOOK] Could not save sub IDs on profile', userId, ':', upd.error);
      return res.status(500).json({ error: 'profile_update_failed' });
    }
    console.log('[STRIPE WEBHOOK] Subscription started: user=' + userId.slice(0, 8) + ' customer=' + s.customer + ' sub=' + s.subscription);
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleSubscriptionCheckoutCompleted error:', e.message);
    return res.status(500).json({ error: 'subscription_checkout_handler_error' });
  }
}

// Recurring billing success: grant the monthly credits. Idempotent keyed on
// invoice.id via purchases.stripe_invoice_id (DB UNIQUE — see migration).
//
// Schema note: in Stripe API 2025-11-17 (and the Invoice consolidation that
// preceded it), the legacy `invoice.subscription` and per-line `subscription`
// fields were removed. The subscription ID is now at
// `invoice.parent.subscription_details.subscription`, with the same metadata
// we set via `subscription_data.metadata` at Checkout living at
// `invoice.parent.subscription_details.metadata`. Read both legacy and new
// paths defensively so a Stripe-side API-version change doesn't silently
// stop crediting renewals (which is exactly what happened on the first
// real customer, invoice in_1TYpTKBkZn5hOJIgLqSCOsv1).
async function handleSubscriptionInvoicePaid(invoice, res) {
  try {
    var subDetails = (invoice.parent && invoice.parent.subscription_details) || null;
    var firstLineParent =
      (invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].parent) || null;
    var subId =
      invoice.subscription
      || (subDetails && subDetails.subscription)
      || (firstLineParent && firstLineParent.subscription_item_details && firstLineParent.subscription_item_details.subscription)
      || null;
    var metaUserId =
      (subDetails && subDetails.metadata && subDetails.metadata.user_id)
      || null;

    if (!subId && !metaUserId) {
      // Genuine "we cannot route this invoice anywhere" case. Fail loud so
      // Stripe retries — silent 200 is what hid the original bug.
      console.error('[STRIPE WEBHOOK] invoice.paid cannot resolve subscription or user_id:',
        'invoice=' + invoice.id,
        'billing_reason=' + invoice.billing_reason,
        'customer=' + invoice.customer,
        'has_parent=' + !!invoice.parent,
        'has_subscription_details=' + !!subDetails,
        'has_first_line=' + !!firstLineParent);
      return res.status(500).json({ error: 'subscription_link_missing' });
    }

    var existing = await supabase.from('purchases')
      .select('id')
      .eq('stripe_invoice_id', invoice.id)
      .maybeSingle();
    if (existing.error) {
      console.error('[STRIPE WEBHOOK] Idempotency lookup failed for invoice', invoice.id, ':', existing.error);
      return res.status(500).json({ error: 'idempotency_check_failed' });
    }
    if (existing.data) {
      console.log('[STRIPE WEBHOOK] Already processed invoice', invoice.id, '— skipping');
      return res.json({ received: true, duplicate: true });
    }

    // Prefer the user_id carried on the invoice payload (no Stripe round-trip).
    // Fall back to the existing helper, which uses stripe.subscriptions.retrieve
    // and finally stripe_customer_id.
    var profile = null;
    if (metaUserId) {
      var pr = await supabase.from('profiles').select('*').eq('id', metaUserId).single();
      if (pr.data) profile = pr.data;
      else console.error('[STRIPE WEBHOOK] metadata.user_id present but profile not found:', metaUserId, 'invoice', invoice.id);
    }
    if (!profile) {
      profile = await findUserForSubscription(subId, invoice.customer);
    }
    if (!profile) {
      console.error('[STRIPE WEBHOOK] No profile for invoice', invoice.id, 'sub=' + subId, 'customer=' + invoice.customer, 'metaUserId=' + metaUserId);
      return res.status(500).json({ error: 'profile_not_found' });
    }

    var currentCredits = profile.credits || 0;
    var billingReason = invoice.billing_reason || '';
    var subSource = billingReason === 'subscription_create' ? 'subscription_initial' : 'subscription_renewal';
    var subNote = subSource === 'subscription_initial' ? 'First subscription payment' : 'Monthly subscription renewal';

    // Atomic balance-update + ledger entry via RPC.
    var newCredits = await recordCreditAdd({
      userId: profile.id,
      amount: SUBSCRIPTION_CREDITS_PER_PAYMENT,
      source: subSource,
      note: subNote,
      stripeInvoiceId: invoice.id
    });
    if (newCredits === null) {
      console.error('[STRIPE WEBHOOK] Subscription credit grant failed for', profile.id, 'invoice', invoice.id);
      return res.status(500).json({ error: 'credit_update_failed' });
    }

    // Non-credit subscription fields (status, customer/sub IDs) updated separately.
    // Credits already granted via RPC; failures here are non-critical.
    var subFieldsUpd = await supabase.from('profiles').update({
      subscription_status: 'active',
      stripe_customer_id: profile.stripe_customer_id || invoice.customer,
      stripe_subscription_id: profile.stripe_subscription_id || subId
    }).eq('id', profile.id);
    if (subFieldsUpd.error) {
      console.error('[STRIPE WEBHOOK] Subscription field update failed (credits already granted) for', profile.id, ':', subFieldsUpd.error);
    }
    console.log('[STRIPE WEBHOOK] Credits granted (sub): ' + profile.id.slice(0, 8) + ' ' + currentCredits + ' -> ' + newCredits + ' (+' + SUBSCRIPTION_CREDITS_PER_PAYMENT + ', ' + subSource + ', invoice ' + invoice.id + ')');

    // payment_intent on the invoice — defensive against the 2025-11-17
    // schema change that moved several invoice fields under invoice.parent.
    var invoicePI =
      invoice.payment_intent
      || (invoice.parent && invoice.parent.payment_settings && invoice.parent.payment_settings.payment_intent)
      || null;
    var purchaseInsert = await supabase.from('purchases').insert({
      user_id: profile.id,
      stripe_session_id: null,
      stripe_invoice_id: invoice.id,
      stripe_payment_intent: invoicePI,
      package_name: 'subscription',
      credits_purchased: SUBSCRIPTION_CREDITS_PER_PAYMENT,
      amount_cents: invoice.amount_paid
    });
    if (purchaseInsert.error) {
      // Credits already granted; log loudly. A retry would hit the idempotency check above.
      console.error('[STRIPE WEBHOOK] Purchases insert failed for invoice', invoice.id, '(credits granted):', purchaseInsert.error);
    }
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleSubscriptionInvoicePaid error:', e.message);
    return res.status(500).json({ error: 'invoice_paid_handler_error' });
  }
}

async function handleSubscriptionInvoicePaymentFailed(invoice, res) {
  try {
    if (!invoice.subscription) return res.json({ received: true });
    var profile = await findUserForSubscription(invoice.subscription, invoice.customer);
    if (!profile) {
      console.error('[STRIPE WEBHOOK] No profile for failed invoice', invoice.id);
      return res.json({ received: true });
    }
    await supabase.from('profiles')
      .update({ subscription_status: 'past_due' })
      .eq('id', profile.id);
    console.log('[STRIPE WEBHOOK] Subscription payment FAILED: user=' + profile.id.slice(0, 8) + ' invoice=' + invoice.id);
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleSubscriptionInvoicePaymentFailed error:', e.message);
    return res.status(500).json({ error: 'invoice_failed_handler_error' });
  }
}

async function handleSubscriptionDeleted(subscription, res) {
  try {
    // Sub is fully canceled now — the "canceling at period end" state is over,
    // so clear those flags. UI keys off subscription_status='canceled' for
    // the terminal "Subscription ended" message.
    var r = await supabase.from('profiles')
      .update({
        subscription_status: 'canceled',
        subscription_cancel_at_period_end: false,
        subscription_cancel_at: null
      })
      .eq('stripe_subscription_id', subscription.id);
    if (r.error) console.error('[STRIPE WEBHOOK] Subscription cancel update failed:', r.error);
    console.log('[STRIPE WEBHOOK] Subscription canceled: sub=' + subscription.id);
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleSubscriptionDeleted error:', e.message);
    return res.status(500).json({ error: 'sub_deleted_handler_error' });
  }
}

// §1 — account.updated webhook for affiliates' Stripe Connect accounts.
// When a connected account's capabilities change (e.g. affiliate finishes
// onboarding and payouts_enabled flips to true), Stripe fires this event.
// We sync the relevant flags onto the profile so the admin UI can show
// onboarding progress and the §6.B pre-transfer cache stays warm.
//
// Note: account.updated is a CONNECT event, not a platform event. The
// webhook endpoint in Stripe Dashboard must be configured to listen to
// events on connected accounts AND have account.updated in its event
// list. Without that, this handler never fires.
async function handleAccountUpdated(account, res) {
  try {
    if (!account || !account.id) {
      console.log('[STRIPE WEBHOOK] account.updated: no account id, ignoring');
      return res.json({ received: true });
    }
    var status = {
      id: account.id,
      charges_enabled: !!account.charges_enabled,
      payouts_enabled: !!account.payouts_enabled,
      details_submitted: !!account.details_submitted
    };
    // Refresh the in-memory cache so the next pre-transfer check sees
    // the new state without an API call.
    _connectAccountCache.set(account.id, { data: status, fetchedAt: Date.now() });
    // Mirror to the profile (cached display fields).
    var r = await supabase.from('profiles').update({
      stripe_connect_charges_enabled: status.charges_enabled,
      stripe_connect_payouts_enabled: status.payouts_enabled,
      stripe_connect_details_submitted: status.details_submitted,
      stripe_connect_updated_at: new Date().toISOString()
    }).eq('stripe_connect_id', account.id);
    if (r.error) {
      console.error('[STRIPE WEBHOOK] account.updated profile sync failed for ' + account.id + ':', r.error);
    }
    console.log('[STRIPE WEBHOOK] Account updated: ' + account.id + ' charges=' + status.charges_enabled + ' payouts=' + status.payouts_enabled + ' details=' + status.details_submitted);
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleAccountUpdated error:', e.message);
    return res.status(500).json({ error: 'account_updated_handler_error' });
  }
}

async function handleSubscriptionUpdated(subscription, res) {
  try {
    var cancelAtEnd = !!subscription.cancel_at_period_end;
    var cancelAtIso = subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null;
    var r = await supabase.from('profiles')
      .update({
        subscription_status: subscription.status,
        subscription_cancel_at_period_end: cancelAtEnd,
        subscription_cancel_at: cancelAtIso
      })
      .eq('stripe_subscription_id', subscription.id);
    if (r.error) console.error('[STRIPE WEBHOOK] Subscription updated update failed:', r.error);
    console.log('[STRIPE WEBHOOK] Subscription updated: sub=' + subscription.id + ' status=' + subscription.status + ' cancel_at_period_end=' + cancelAtEnd + (cancelAtIso ? ' cancel_at=' + cancelAtIso : ''));
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleSubscriptionUpdated error:', e.message);
    return res.status(500).json({ error: 'sub_updated_handler_error' });
  }
}

// §6.D — Affiliate commission clawback for refunds and chargebacks.
// Finds the purchase tied to the refunded/disputed charge, then reverses
// every affiliate_earnings row tied to that purchase:
//   - status='transferred' + stripe_transfer_id → call
//     stripe.transfers.createReversal on the connected account.
//   - status='credited' (non-Connect) → decrement
//     affiliate_balance_cents (floor at 0).
//   - status='failed' → no money moved; mark 'reversed' and move on.
//   - status='reversed' / 'reversal_failed' → already handled; skip
//     (this is the idempotency guard: a duplicate refund event won't
//     reverse twice because the row's status reflects prior action).
//
// Looks up the purchase by stripe_payment_intent first (added in
// migration 006); falls back to stripe_invoice_id for subscription
// renewals where charge.invoice is on the payload. Old purchases from
// before migration 006 will fail to match for one-time bundles —
// admin would need to claw back manually.
async function clawbackAffiliateCommissionForCharge(opts) {
  // opts: { paymentIntentId, invoiceId, chargeId, reason, sourceEventId }
  var paymentIntentId = opts.paymentIntentId || null;
  var invoiceId = opts.invoiceId || null;
  var chargeId = opts.chargeId || null;
  var reason = opts.reason || 'unknown';
  var sourceEventId = opts.sourceEventId || null;

  // Locate the purchase. Prefer payment_intent (most reliable, all flows);
  // fall back to invoice_id (works for subscriptions).
  var purchase = null;
  if (paymentIntentId) {
    var byPi = await supabase.from('purchases')
      .select('id, user_id, amount_cents, stripe_session_id, stripe_invoice_id')
      .eq('stripe_payment_intent', paymentIntentId)
      .maybeSingle();
    if (byPi.data) purchase = byPi.data;
  }
  if (!purchase && invoiceId) {
    var byInv = await supabase.from('purchases')
      .select('id, user_id, amount_cents, stripe_session_id, stripe_invoice_id')
      .eq('stripe_invoice_id', invoiceId)
      .maybeSingle();
    if (byInv.data) purchase = byInv.data;
  }
  if (!purchase) {
    console.log('[CLAWBACK] No purchase matched for ' + reason + ' charge=' + chargeId + ' pi=' + paymentIntentId + ' invoice=' + invoiceId + ' — affiliate commission (if any) not clawed back, admin action may be required');
    return { matchedPurchase: false, reversed: 0, failed: 0 };
  }

  // Find every affiliate_earnings row tied to this purchase. Could be 0 or 1
  // in current data shape (one commission per purchase), but the loop is
  // robust to future "split commission" scenarios.
  var er = await supabase.from('affiliate_earnings')
    .select('id, affiliate_id, amount_cents, status, stripe_transfer_id')
    .eq('purchase_id', purchase.id);
  if (er.error) {
    console.error('[CLAWBACK] Failed to read affiliate_earnings for purchase ' + purchase.id + ':', er.error);
    return { matchedPurchase: true, reversed: 0, failed: 0, error: er.error.message };
  }
  var earnings = er.data || [];
  if (earnings.length === 0) {
    console.log('[CLAWBACK] No affiliate earnings on purchase ' + purchase.id + ' (' + reason + ') — nothing to reverse');
    return { matchedPurchase: true, reversed: 0, failed: 0 };
  }

  var reversedCount = 0;
  var failedCount = 0;
  for (var i = 0; i < earnings.length; i++) {
    var e = earnings[i];

    // Idempotency: if this row was already handled by a prior event, skip.
    if (e.status === 'reversed' || e.status === 'reversal_failed') {
      console.log('[CLAWBACK] Earning ' + e.id + ' already in terminal state (' + e.status + ') — skipping (' + reason + ')');
      continue;
    }

    if (e.status === 'transferred' && e.stripe_transfer_id) {
      // Connect affiliate — reverse the Stripe transfer.
      try {
        await stripe.transfers.createReversal(e.stripe_transfer_id, {
          amount: e.amount_cents,
          description: 'Affiliate commission clawback (' + reason + ')'
        }, {
          idempotencyKey: 'aff-reverse-' + e.id
        });
        await supabase.from('affiliate_earnings').update({
          status: 'reversed',
          error_message: null
        }).eq('id', e.id);
        reversedCount++;
        console.log('[CLAWBACK] Reversed transfer ' + e.stripe_transfer_id + ' for earning ' + e.id + ' (' + reason + ', source=' + sourceEventId + ')');
      } catch (re) {
        var rmsg = re && re.message ? re.message : String(re);
        // Common cause: affiliate already withdrew the funds, connected
        // account doesn't have the balance to reverse. Mark for manual
        // admin handling.
        await supabase.from('affiliate_earnings').update({
          status: 'reversal_failed',
          error_message: rmsg
        }).eq('id', e.id);
        failedCount++;
        console.error('[CLAWBACK] Reversal FAILED for earning ' + e.id + ' transfer ' + e.stripe_transfer_id + ' (' + reason + '):', rmsg);
      }
    } else if (e.status === 'credited') {
      // Non-Connect affiliate — decrement their pending balance.
      var pr = await supabase.from('profiles')
        .select('id, affiliate_balance_cents')
        .eq('id', e.affiliate_id)
        .single();
      if (pr.error || !pr.data) {
        console.error('[CLAWBACK] Could not read profile for affiliate ' + e.affiliate_id + ' (' + reason + '):', pr.error);
        failedCount++;
        continue;
      }
      var currentBal = pr.data.affiliate_balance_cents || 0;
      var newBal = Math.max(0, currentBal - e.amount_cents);
      var shortfall = (currentBal - e.amount_cents) < 0 ? Math.abs(currentBal - e.amount_cents) : 0;
      var bu = await supabase.from('profiles').update({ affiliate_balance_cents: newBal }).eq('id', e.affiliate_id);
      if (bu.error) {
        console.error('[CLAWBACK] Balance decrement failed for affiliate ' + e.affiliate_id + ':', bu.error);
        failedCount++;
        continue;
      }
      await supabase.from('affiliate_earnings').update({
        status: 'reversed',
        error_message: shortfall > 0 ? ('Balance was already partially paid out; shortfall=' + shortfall + ' cents — manual recovery needed') : null
      }).eq('id', e.id);
      reversedCount++;
      console.log('[CLAWBACK] Reversed credit-balance earning ' + e.id + ' for affiliate ' + e.affiliate_id.slice(0, 8) + ' (' + reason + ') balance ' + currentBal + ' -> ' + newBal + (shortfall > 0 ? ' SHORTFALL=' + shortfall : ''));
    } else if (e.status === 'failed') {
      // Original transfer never succeeded → nothing to reverse on Stripe.
      // Mark 'reversed' so the row reflects the final outcome and admin
      // doesn't try to retry a now-defunct commission.
      await supabase.from('affiliate_earnings').update({
        status: 'reversed',
        error_message: 'Original transfer never succeeded; reversed without Stripe action (' + reason + ')'
      }).eq('id', e.id);
      reversedCount++;
      console.log('[CLAWBACK] Marked failed-earning ' + e.id + ' as reversed (no money moved; ' + reason + ')');
    } else {
      console.log('[CLAWBACK] Earning ' + e.id + ' in unexpected state (' + e.status + ') — skipping (' + reason + ')');
    }
  }

  return { matchedPurchase: true, reversed: reversedCount, failed: failedCount };
}

// When a charge is FULLY refunded: cancel the subscription (existing
// behavior) AND claw back any affiliate commission tied to the refunded
// charge (§6.D). Partial refunds are still ignored — only full refunds
// trigger clawback, matching the existing partial-refund policy.
// Credits granted to the customer are intentionally NOT touched here —
// refunding money and clawing back credits are separate decisions; this
// handler manages subscription and affiliate state only.
//
// Idempotency: the customer-subscription cancel call is checked-then-called,
// so a duplicate charge.refunded event finds the sub already 'canceled' and
// no-ops cleanly. The profile update is also idempotent (writing 'canceled'
// over 'canceled' is a no-op write).
async function handleChargeRefunded(charge, res) {
  try {
    // FULL refund only. Stripe sets charge.refunded=true once amount_refunded
    // covers the full amount; for partial refunds the event still fires but
    // .refunded stays false. Partial refunds don't claw back commission
    // either — full refund is the policy threshold for both subscription
    // cancel and affiliate clawback.
    if (charge.refunded !== true) {
      console.log('[STRIPE WEBHOOK] charge.refunded: partial refund, leaving subscription + affiliate commission alone. charge=' + charge.id + ' refunded=' + charge.amount_refunded + '/' + charge.amount);
      return res.json({ received: true, partial: true });
    }

    // §6.D — claw back affiliate commission tied to this charge.
    // Runs first (independent of customer/subscription state) so commission
    // is always reversed on a full refund even if the customer lookup fails
    // or the subscription was already canceled.
    await clawbackAffiliateCommissionForCharge({
      paymentIntentId: charge.payment_intent || null,
      invoiceId: charge.invoice || null,
      chargeId: charge.id,
      reason: 'charge.refunded',
      sourceEventId: charge.id
    });

    var customerId = charge.customer;
    if (!customerId) {
      console.log('[STRIPE WEBHOOK] charge.refunded: no customer on charge, nothing to do. charge=' + charge.id);
      return res.json({ received: true });
    }

    var pr = await supabase.from('profiles')
      .select('id, email, stripe_subscription_id, subscription_status')
      .eq('stripe_customer_id', customerId)
      .single();
    if (pr.error || !pr.data) {
      console.log('[STRIPE WEBHOOK] charge.refunded: no profile matches customer ' + customerId + ' (charge=' + charge.id + ')');
      return res.json({ received: true });
    }
    var profile = pr.data;

    if (!profile.stripe_subscription_id) {
      console.log('[STRIPE WEBHOOK] charge.refunded: profile ' + profile.id.slice(0, 8) + ' has no subscription, nothing to cancel. charge=' + charge.id);
      return res.json({ received: true });
    }

    // Check current status before calling cancel — Stripe returns 400 if you
    // try to cancel an already-canceled subscription. Also lets us no-op on
    // a duplicate event delivery without doing anything destructive.
    var sub;
    try {
      sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    } catch (e) {
      console.error('[STRIPE WEBHOOK] charge.refunded: could not retrieve sub ' + profile.stripe_subscription_id + ' for charge ' + charge.id + ':', e.message);
      // Sync the profile anyway — if the sub is unretrievable it's not usable.
      await supabase.from('profiles').update({ subscription_status: 'canceled' }).eq('id', profile.id);
      return res.json({ received: true });
    }

    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      console.log('[STRIPE WEBHOOK] charge.refunded: sub ' + profile.stripe_subscription_id + ' already terminal (' + sub.status + ') — syncing DB only. charge=' + charge.id);
      await supabase.from('profiles').update({ subscription_status: 'canceled' }).eq('id', profile.id);
      return res.json({ received: true, already_canceled: true });
    }

    // Immediate cancel — refund just happened, no point keeping the period alive.
    var canceled;
    try {
      canceled = await stripe.subscriptions.cancel(profile.stripe_subscription_id);
    } catch (e) {
      console.error('[STRIPE WEBHOOK] charge.refunded: cancel failed for sub ' + profile.stripe_subscription_id + ' (charge ' + charge.id + '):', e.message);
      return res.status(500).json({ error: 'subscription_cancel_failed' });
    }

    console.log('[STRIPE WEBHOOK] Subscription auto-canceled after full refund: user=' + profile.id.slice(0, 8) + ' sub=' + profile.stripe_subscription_id + ' charge=' + charge.id + ' new_status=' + canceled.status);

    var upd = await supabase.from('profiles').update({ subscription_status: 'canceled' }).eq('id', profile.id);
    if (upd.error) {
      // Sub IS canceled on Stripe's side; the customer.subscription.deleted
      // event will fire next and our handler there will sync the field.
      console.error('[STRIPE WEBHOOK] charge.refunded: profile update failed for ' + profile.id + ':', upd.error);
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleChargeRefunded error:', e.message, e.stack);
    return res.status(500).json({ error: 'charge_refunded_handler_error' });
  }
}

// §6.D — A chargeback / dispute is also a money-out event. Treat it as a
// refund for the purpose of affiliate commission clawback. We do NOT
// auto-cancel the subscription on dispute (the customer might be disputing
// fraudulently and you may win) — that's a different policy call. We DO
// claw back the affiliate's commission immediately to limit exposure.
// If you later win the dispute (charge.dispute.closed status='won'), the
// commission won't auto-reinstate — that's a manual admin action for now.
async function handleChargeDisputeCreated(dispute, res) {
  try {
    var pi = dispute.payment_intent || null;
    var chargeId = dispute.charge || null;
    if (!pi && !chargeId) {
      console.log('[STRIPE WEBHOOK] charge.dispute.created: no payment_intent or charge id, nothing to do. dispute=' + dispute.id);
      return res.json({ received: true });
    }
    var result = await clawbackAffiliateCommissionForCharge({
      paymentIntentId: pi,
      invoiceId: null, // dispute payload doesn't carry invoice; payment_intent is sufficient for the lookup
      chargeId: chargeId,
      reason: 'charge.dispute.created',
      sourceEventId: dispute.id
    });
    console.log('[STRIPE WEBHOOK] dispute.created: dispute=' + dispute.id + ' charge=' + chargeId + ' pi=' + pi + ' matched=' + result.matchedPurchase + ' reversed=' + result.reversed + ' failed=' + result.failed);
    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] handleChargeDisputeCreated error:', e.message, e.stack);
    return res.status(500).json({ error: 'charge_dispute_created_handler_error' });
  }
}

app.post('/webhook/stripe', async function(req, res) {
  var event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[STRIPE WEBHOOK] Signature verification failed:', e.message);
    return res.status(400).send('Webhook error');
  }

  console.log('[STRIPE WEBHOOK] Received event:', event.type, event.id);

  // Subscription event branches — no affiliate logic in any of these.
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    return handleSubscriptionInvoicePaid(event.data.object, res);
  }
  if (event.type === 'invoice.payment_failed') {
    return handleSubscriptionInvoicePaymentFailed(event.data.object, res);
  }
  if (event.type === 'customer.subscription.deleted') {
    return handleSubscriptionDeleted(event.data.object, res);
  }
  if (event.type === 'customer.subscription.updated') {
    return handleSubscriptionUpdated(event.data.object, res);
  }
  if (event.type === 'charge.refunded') {
    return handleChargeRefunded(event.data.object, res);
  }
  if (event.type === 'charge.dispute.created') {
    return handleChargeDisputeCreated(event.data.object, res);
  }
  if (event.type === 'account.updated') {
    return handleAccountUpdated(event.data.object, res);
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledge but ignore — other event types aren't handled yet.
    console.log('[STRIPE WEBHOOK] Ignoring event type:', event.type);
    return res.json({ received: true });
  }

  var s = event.data.object;

  // Subscription Checkout completion — capture customer/sub IDs. Credits will
  // be granted by invoice.paid (which also fires on the first payment).
  // AFFILIATE LOGIC IS INTENTIONALLY SKIPPED FOR SUBSCRIPTIONS.
  if (s.mode === 'subscription') {
    return handleSubscriptionCheckoutCompleted(s, res);
  }

  // One-time payment path below — UNCHANGED from previous behavior, including
  // the existing affiliate / Stripe Connect commission logic.
  var userId = s.metadata && s.metadata.user_id;
  var creditsToAdd = parseInt(s.metadata && s.metadata.credits);

  if (!userId || isNaN(creditsToAdd)) {
    console.error('[STRIPE WEBHOOK] Missing/invalid metadata on session', s.id, 'metadata:', JSON.stringify(s.metadata));
    // Return 200 so Stripe doesn't retry forever — we logged the problem.
    return res.json({ received: true, error: 'missing_metadata' });
  }

  try {
    // IDEMPOTENCY: If we've already processed this session, do nothing.
    // Relies on stripe_session_id existing in the purchases row written below.
    var existing = await supabase.from('purchases')
      .select('id')
      .eq('stripe_session_id', s.id)
      .maybeSingle();
    if (existing.error) {
      console.error('[STRIPE WEBHOOK] Idempotency lookup failed:', existing.error);
      // Fail loud — Stripe will retry, and the next attempt may succeed.
      return res.status(500).json({ error: 'idempotency_check_failed' });
    }
    if (existing.data) {
      console.log('[STRIPE WEBHOOK] Already processed session', s.id, '— skipping');
      return res.json({ received: true, duplicate: true });
    }

    // Read the profile up front. If it doesn't exist, fail loud so Stripe
    // retries — better than silently never crediting.
    var profileResult = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (profileResult.error || !profileResult.data) {
      console.error('[STRIPE WEBHOOK] Profile not found for user', userId, 'session', s.id, profileResult.error);
      return res.status(500).json({ error: 'profile_not_found' });
    }
    var profile = profileResult.data;
    var currentCredits = profile.credits || 0;

    // Atomic balance-update + ledger entry via RPC.
    var newCredits = await recordCreditAdd({
      userId: userId,
      amount: creditsToAdd,
      source: 'bundle_purchase',
      note: 'Bundle: ' + (s.metadata.package_id || 'unknown'),
      stripeSessionId: s.id
    });
    if (newCredits === null) {
      console.error('[STRIPE WEBHOOK] Credit grant failed for', userId, 'session', s.id);
      return res.status(500).json({ error: 'credit_update_failed' });
    }
    console.log('[STRIPE WEBHOOK] Credits granted: ' + userId.slice(0, 8) + ' ' + currentCredits + ' -> ' + newCredits + ' (+' + creditsToAdd + ', session ' + s.id + ')');

    var purchaseResult = await supabase.from('purchases').insert({
      user_id: userId,
      stripe_session_id: s.id,
      stripe_payment_intent: s.payment_intent || null,
      package_name: s.metadata.package_id,
      credits_purchased: creditsToAdd,
      amount_cents: s.amount_total
    }).select().single();
    if (purchaseResult.error) {
      // Credit grant already succeeded; log loudly but don't 500 (would cause
      // Stripe to retry and our idempotency check above would then catch it).
      console.error('[STRIPE WEBHOOK] Purchases insert failed for session', s.id, '(credits were granted):', purchaseResult.error);
    }

    // AFFILIATE COMMISSION — accept either a code passed at checkout or a
    // prior referral lock on the profile. Failures here log but never undo
    // the credit grant above. Gated by AFFILIATE_ENABLED so a bundle
    // purchase still succeeds and credits are still granted when the
    // program is off — only the commission/transfer path is skipped.
    if (!AFFILIATE_ENABLED) {
      console.log('[STRIPE WEBHOOK] Affiliate program disabled — skipping commission for session ' + s.id);
      return res.json({ received: true });
    }

    var affiliateId = s.metadata.affiliate_id || null;
    var affiliateCode = s.metadata.affiliate_code || null;

    if (!affiliateId && profile.referred_by) {
      affiliateCode = profile.referred_by;
      // Shared safe resolver — normalizes case (profile.referred_by SHOULD
      // already be uppercase since every writer uppercases, but be
      // defensive) and refuses to attribute commission on a duplicate-code
      // match (returns null, commission processing is skipped below since
      // affiliateId stays null).
      var refMatch = await resolveAffiliateByCode(profile.referred_by);
      if (refMatch) {
        affiliateId = refMatch.id;
      } else {
        console.error('[AFFILIATE] Webhook resolver could not safely resolve referred_by="' + profile.referred_by + '" for user ' + userId.slice(0, 8) + ' (session ' + s.id + ') — commission NOT paid. See preceding [AFFILIATE] log for reason (not found OR duplicate).');
      }
    }

    if (affiliateId) {
      try {
        var referrerResult = await supabase.from('profiles')
          .select('id, affiliate_balance_cents, affiliate_total_earned_cents, stripe_connect_id')
          .eq('id', affiliateId)
          .single();

        if (referrerResult.data) {
          var commission = Math.floor(s.amount_total * AFFILIATE_COMMISSION_PERCENT / 100);
          // §6.A (double-pay hole): Connect affiliates do NOT accrue
          // affiliate_balance_cents — their Stripe transfer IS the payout.
          // affiliate_total_earned_cents increments unconditionally (lifetime).
          var isConnect = !!referrerResult.data.stripe_connect_id;
          var newBalance = isConnect
            ? (referrerResult.data.affiliate_balance_cents || 0)
            : (referrerResult.data.affiliate_balance_cents || 0) + commission;
          var newTotal = (referrerResult.data.affiliate_total_earned_cents || 0) + commission;

          await supabase.from('profiles').update({
            affiliate_balance_cents: newBalance,
            affiliate_total_earned_cents: newTotal
          }).eq('id', referrerResult.data.id);

          // §3 (silent transfer failures): for Connect affiliates, attempt the
          // Stripe transfer FIRST, then record the row with the real outcome.
          // Old order recorded status='transferred' before transfer ran, so a
          // failure left the DB lying. Now: status is one of
          //   'transferred' (with stripe_transfer_id), 'failed' (with
          //   error_message), or 'credited' (non-Connect, no transfer needed).
          var earningStatus = 'credited';
          var stripeTransferId = null;
          var transferErrorMessage = null;
          if (isConnect) {
            // §6.B — pre-flight check: never transfer to an account that
            // can't receive payouts. Without this guard, funds either fail
            // outright or land in a frozen holding balance the affiliate
            // can't withdraw. The row gets marked 'failed' (reusing §3's
            // failed-retry queue) with a clear error_message; admin clicks
            // retry once the affiliate finishes Stripe onboarding.
            var connectStatus = await getConnectAccountStatus(referrerResult.data.stripe_connect_id);
            if (connectStatus) {
              // Opportunistically sync the cache columns on the profile
              // since we just paid for a fresh API call.
              await syncConnectStatusToProfile(referrerResult.data.stripe_connect_id, connectStatus);
            }
            if (!connectStatus) {
              earningStatus = 'failed';
              transferErrorMessage = 'Could not verify Connect account status (Stripe API error). Admin can retry via /api/admin/affiliate-earnings/:id/retry.';
              console.error('[CONNECT] SKIPPING transfer for ' + referrerResult.data.stripe_connect_id + ' — Stripe API unreachable; earning marked failed');
            } else if (!connectStatus.payouts_enabled) {
              earningStatus = 'failed';
              transferErrorMessage = 'Connect account not payouts_enabled (charges_enabled=' + connectStatus.charges_enabled + ', details_submitted=' + connectStatus.details_submitted + '). Affiliate needs to complete Stripe onboarding; admin can retry via /api/admin/affiliate-earnings/:id/retry once ready.';
              console.error('[CONNECT] SKIPPING transfer for ' + referrerResult.data.stripe_connect_id + ' — payouts_enabled=false (charges=' + connectStatus.charges_enabled + ' details=' + connectStatus.details_submitted + ')');
            } else {
              // Account is ready — proceed with the transfer.
              try {
                var transfer = await stripe.transfers.create({
                  amount: commission,
                  currency: 'usd',
                  destination: referrerResult.data.stripe_connect_id,
                  description: 'Affiliate commission for referral'
                }, {
                  // Idempotency: a webhook replay must not create a second transfer.
                  idempotencyKey: 'aff-commission-' + s.id
                });
                earningStatus = 'transferred';
                stripeTransferId = transfer.id;
                console.log('[CONNECT] Transferred $' + (commission / 100).toFixed(2) + ' to ' + referrerResult.data.stripe_connect_id + ' tr=' + transfer.id);
              } catch (te) {
                earningStatus = 'failed';
                transferErrorMessage = te && te.message ? te.message : String(te);
                console.error('[CONNECT] Transfer FAILED for ' + referrerResult.data.stripe_connect_id + ' (earnings row marked failed; retry via /api/admin/affiliate-earnings/:id/retry):', transferErrorMessage);
              }
            }
          }

          await supabase.from('affiliate_earnings').insert({
            affiliate_id: referrerResult.data.id,
            referred_id: userId,
            purchase_id: purchaseResult.data ? purchaseResult.data.id : null,
            amount_cents: commission,
            purchase_amount_cents: s.amount_total,
            status: earningStatus,
            stripe_transfer_id: stripeTransferId,
            error_message: transferErrorMessage
          });

          await supabase.from('referrals')
            .update({ status: 'converted' })
            .eq('referred_id', userId)
            .eq('status', 'signed_up');

          console.log('[AFFILIATE] Commission $' + (commission / 100).toFixed(2) + ' for referrer of ' + profile.email + ' status=' + earningStatus);
        }
      } catch (ae) {
        console.error('[AFFILIATE] Commission processing failed (credit grant unaffected):', ae.message);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE WEBHOOK] Unhandled error processing session', s.id, ':', e.message, e.stack);
    res.status(500).json({ error: 'webhook_handler_error' });
  }
});

app.post('/api/call', auth, async function(req, res) {
  if (!req.profile.isDev && req.profile.credits < 1) {
    return res.status(402).json({ error: 'No credits' });
  }
  
  var county = req.body.county || "montgomery"; var targetNumber = getCountyConfig(county).number;
  var pin = req.body.pin;
  var notifyNumber = req.body.notifyNumber;
  var notifyEmail = req.body.notifyEmail;
  var notifyMethod = req.body.notifyMethod || 'email';

  var countyConfig = COUNTIES[county] || COUNTIES['montgomery'];
  if (countyConfig.process !== 'color' && !pin) return res.status(400).json({ error: 'PIN required for this county' });
  if (!/^\+\d{10,15}$/.test(targetNumber)) return res.status(400).json({ error: 'Invalid phone format' });
  if (pin && (pin.length !== 6 || !/^\d+$/.test(pin))) return res.status(400).json({ error: 'PIN must be 6 digits' });
  
  try {
    // Credit is deducted in /webhook/recording once a result is known.
    var result = await initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, req.user.id, 0, county);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function initiateCall(targetNumber, pin, notifyNumber, notifyEmail, notifyMethod, userId, retryCount, county, isScheduledMorning) {
  var callId = 'call_' + Date.now();
  log(callId, 'Starting call to ' + targetNumber + (retryCount > 0 ? ' (retry #' + retryCount + ')' : ''), 'info');

  pendingCalls.set(callId, {
    targetNumber: targetNumber,
    pin: pin,
    county: county,
    notifyNumber: notifyNumber,
    notifyEmail: notifyEmail,
    notifyMethod: notifyMethod,
    userId: userId,
    retryCount: retryCount,
    isScheduledMorning: isScheduledMorning === true,
    result: null
  });
  
  var call = await twilioClient.calls.create({
    to: targetNumber,
    from: TWILIO_VOICE_NUMBER,
    url: process.env.BASE_URL + '/twiml/answer?callId=' + callId,
    statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    record: true,
    recordingStatusCallback: process.env.BASE_URL + '/webhook/recording?callId=' + callId,
    timeout: 60
  });
  
  pendingCalls.get(callId).callSid = call.sid;
  log(callId, 'Call SID: ' + call.sid, 'success');
  
  // Clean up old pending calls after 10 minutes
  setTimeout(function() {
    pendingCalls.delete(callId);
  }, 10 * 60 * 1000);
  
  return { success: true, callId: callId, callSid: call.sid };
}

// scheduleRetry() was only invoked from the removed <Gather> handlers
// (/twiml/result and /twiml/fallback). Empty-transcript retries now happen
// inline in /webhook/recording when Deepgram returns an empty transcript.

app.post('/twiml/answer', function(req, res) {
  var callId = req.query.callId;
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  if (!config) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }
  
  log(callId, 'Call answered, sending DTMF', 'success');
  twiml.play({ digits: 'wwwwwwwwww1wwwwwwwwwwwwwwwwwwww' + config.pin + 'wwwwwwwwwwwwwwwwwwww1' });
  twiml.pause({ length: 2 });
  twiml.pause({ length: 20 });
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// /twiml/result and /twiml/fallback (used to be Twilio <Gather> action URLs)
// were removed — the current call flow uses post-call Deepgram transcription
// in /webhook/recording instead. Re-add them only if <Gather> is reintroduced.

app.post('/webhook/recording', async function(req, res) {
  var callId = req.query.callId;
  var recordingUrl = req.body.RecordingUrl;
  
  console.log('[RECORDING] CallId:', callId, 'URL:', recordingUrl);
  res.sendStatus(200);
  
  if (!recordingUrl || !callId) return;
  
  var mp3Url = recordingUrl + '.mp3';
  var config = pendingCalls.get(callId);
  
  if (!config) return;
  
  // Save recording URL first
  if (config.isFtbendDaily) {
    var now = new Date();
    var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
    var countyKey = 'ftbend_' + (config.officeId || 'missouri');
    await supabase.from('daily_county_status')
      .update({ recording_url: mp3Url })
      .eq('county', countyKey)
      .eq('date', today);
    console.log('[RECORDING] Saved Fort Bend daily recording for', countyKey, today);
  } else if (config.callSid) {
    await supabase.from('call_history')
      .update({ recording_url: mp3Url })
      .eq('call_sid', config.callSid);
    console.log('[RECORDING] Saved Montgomery recording for', config.callSid);
  }
  
  // Transcribe with Deepgram
  try {
    console.log('[TRANSCRIBE] Starting Deepgram transcription for', callId);
    var audioUrl = recordingUrl + '.mp3';
    // Download from Twilio with auth
    var audioResponse = await fetch(audioUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64')
      }
    });
    var audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    console.log('[TRANSCRIBE] Downloaded audio:', audioBuffer.length, 'bytes');
    var dgResponse = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + process.env.DEEPGRAM_API_KEY,
        'Content-Type': 'audio/mpeg'
      },
      body: audioBuffer
    });
    var dgResult = await dgResponse.json();
    var transcript = (dgResult.results && dgResult.results.channels && dgResult.results.channels[0] && dgResult.results.channels[0].alternatives && dgResult.results.channels[0].alternatives[0] && dgResult.results.channels[0].alternatives[0].transcript) || '';
    
    console.log('[TRANSCRIBE] Result: "' + transcript + '"');
    
    if (!transcript) {
      console.log('[TRANSCRIBE] Empty transcript for', callId);
      // Retry if we haven't retried too many times
      var retryCount = config.transcribeRetry || 0;
      if (retryCount < 2 && config.userId && !config.isFtbendDaily) {
        console.log('[TRANSCRIBE] Retrying call for', callId, '(attempt ' + (retryCount + 1) + ')');
        try {
          // Inherit isScheduledMorning so the transcribeRetry chain stays
          // attached to the same morning-aggregation flow per design §6.
          // (The arg slot also previously held leftover false/0 values from
          // the deleted retryOnUnknown signature — now correctly carries
          // retryCount, county, and isScheduledMorning.)
          var retryResult = await initiateCall(config.targetNumber, config.pin, config.notifyNumber, config.notifyEmail, config.notifyMethod, config.userId, retryCount + 1, config.county, config.isScheduledMorning);
          // Mark the specific new pendingCall (not "the last key in the Map",
          // which races with any other concurrent call that just started).
          if (retryResult && retryResult.callId && pendingCalls.get(retryResult.callId)) {
            pendingCalls.get(retryResult.callId).transcribeRetry = retryCount + 1;
          }
        } catch (e) {
          console.error('[TRANSCRIBE] Retry failed:', e.message);
        }
      } else {
        // Max retries hit or Fort Bend - alert admin and user
        console.log('[TRANSCRIBE] Max retries reached or skipped for', callId);
        if (config.notifyNumber && !config.isFtbendDaily) {
          await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod,
            '⚠️ Call Issue\n\nThe hotline may be experiencing issues today. We could not get a clear result after multiple attempts.\n\nPlease call the hotline manually to verify:\n+1 (936) 283-4848\n\n- ProbationCall.com', callId);
        }
        // Alert admins
        var adminResult = await supabase.from('profiles').select('id').eq('is_admin', true);
        if (adminResult.data) {
          for (var a = 0; a < adminResult.data.length; a++) {
            var adminSched = await supabase.from('user_schedules').select('notify_number, notify_email, notify_method').eq('user_id', adminResult.data[a].id).single();
            if (adminSched.data && adminSched.data.notify_number) {
              await sendSMS(adminSched.data.notify_number,
                '🚨 ADMIN ALERT: Empty transcripts detected!\n\nCall ' + callId + ' returned empty after retries. The hotline may be down.\n\nCheck probationcall.com/admin', 'admin_alert');
            }
          }
        }
        // Gap 3: write a call_history row so the :45 recovery cron sees the
        // user was handled today and doesn't fire a duplicate 4th call.
        // billed_at NULL — no credit charged for this outcome (billing is
        // gated on MUST_TEST/NO_TEST only). HOTLINE_DOWN counts toward the
        // no-result auto-pause streak alongside UNKNOWN and CALL_FAILED.
        // PIN_EXPIRED counter is untouched. Fort Bend system calls have no
        // per-user userId — skip both the streak check and the insert.
        if (config.userId && !config.isFtbendDaily) {
          if (config.isScheduledMorning) {
            // Route into morning-aggregated retry flow — no notify, no
            // streak, no call_history row written here. Handler decides
            // whether to queue another retry or final-fail.
            await handleScheduledMorningNoResult(config, 'HOTLINE_DOWN', config.callSid, null, recordingUrl + '.mp3');
          } else {
            // Non-scheduled (manual/admin) call — keep the d8bfe71 behavior:
            // notify-via-existing-admin-alert above, write a HOTLINE_DOWN row,
            // run the streak check. Await BEFORE insert so the SELECT can't
            // race with the INSERT.
            await checkConsecutiveUnknown(config.userId, '(empty transcript x3 — hotline likely down)', config.notifyNumber, config.notifyEmail, config.notifyMethod)
              .catch(function(e) { console.error('[UNKNOWN-STREAK] check failed:', e.message); });

            var downRow = {
              user_id: config.userId,
              call_sid: config.callSid || 'unknown',
              target_number: config.targetNumber || '+19362834848',
              pin_used: config.pin,
              result: 'HOTLINE_DOWN',
              recording_url: recordingUrl + '.mp3',
              created_at: new Date().toISOString()
            };
            var downInsert = await supabase.from('call_history').insert(downRow);
            if (downInsert.error) {
              console.error('[TRANSCRIBE] HOTLINE_DOWN insert error for', callId, ':', downInsert.error);
            } else {
              console.log('[TRANSCRIBE] Saved HOTLINE_DOWN to call_history for', callId);
            }
          }
        }
      }
      return;
    }
    
    var lower = transcript.toLowerCase();
    
    if (config.isFtbendDaily) {
      // Fort Bend - detect color and phases
      var officeId = config.officeId || 'missouri';
      var detectedColor = detectColor(lower);
      var phases = (typeof detectPhaseColors === 'function') ? detectPhaseColors(transcript) : { phase1: null, phase2: null };

      // Set on config so notifyFtbendOfficeUsers can read them
      config.phase1 = phases.phase1;
      config.phase2 = phases.phase2;

      // Our own detection — what Deepgram + detectColor parsed.
      var ourDetection = detectedColor || phases.phase1 || 'UNKNOWN';
      console.log('[TRANSCRIBE] Fort Bend ' + officeId + ' our_detection:', ourDetection);

      // Cross-check against finishprobation.com ground truth. Network call
      // (~500ms-2s); res.sendStatus(200) already fired at /webhook/recording
      // entry so Twilio isn't waiting.
      var groundTruthResult = await fetchFinishProbationGroundTruth(officeId).catch(function(e) {
        console.error('[FTBEND-XCHECK] fetch threw for ' + officeId + ':', e.message);
        return { error: 'fetch_threw:' + e.message };
      });
      var groundTruthArr = groundTruthResult.testGroups || null;
      var crossCheck = doCrossCheck(transcript, ourDetection, groundTruthArr);

      console.log('[FTBEND-XCHECK] office=' + officeId
        + ' our=' + ourDetection
        + ' truth=' + (groundTruthArr ? groundTruthArr.join(', ') : '(' + (groundTruthResult.error || 'none') + ')')
        + ' method=' + crossCheck.match_method
        + (crossCheck.misrecognition_added ? ' added=' + crossCheck.misrecognition_added : ''));

      // Look up existing retry row to derive thisAttemptNumber. If a row
      // exists, this webhook is resolving a poller-fired retry → increment.
      // If no row, this is attempt 1 (the original 5:05 cron-fired call).
      var existingRetryResult = await supabase.from('fort_bend_retries').select('*').eq('office', officeId).maybeSingle();
      var existingRetry = (existingRetryResult && existingRetryResult.data) || null;
      var thisAttemptNumber = existingRetry ? existingRetry.attempt_number + 1 : 1;

      var ftbendLearningDate = formatLocalDay(new Date(), 'America/Chicago');
      var ftbendOfficeHotline = (FTBEND_OFFICES[officeId] && FTBEND_OFFICES[officeId].number) || '';
      var loggedMethod = crossCheck.match_method;
      var loggedGroundTruth = groundTruthArr ? groundTruthArr.join(', ') : null;
      var loggedMisrecognition = crossCheck.misrecognition_added;

      // Decision branch. doCrossCheck's three confirmed methods short-circuit
      // straight to notify+store+delete-row. no_ground_truth and no_match
      // either queue a retry (within window) or final-fail (cutoff).
      if (crossCheck.match_method === 'detection_already_correct'
          || crossCheck.match_method === 'substring'
          || crossCheck.match_method === 'phonetic') {
        // CONFIRMED — notify, store, delete retry row if it exists.
        config.result = crossCheck.final_answer;
        await storeFtbendColor(crossCheck.final_answer, transcript, officeId, phases.phase1, phases.phase2);
        await notifyFtbendOfficeUsers(officeId, config);
        if (existingRetry) {
          await supabase.from('fort_bend_retries').delete().eq('id', existingRetry.id).then(function() {}, function(e) {
            console.error('[FTBEND-RETRY] delete-on-confirm failed for ' + officeId + ':', e.message);
          });
          console.log('[FTBEND-RETRY] Resolved ' + officeId + ' on attempt ' + thisAttemptNumber + ' (' + crossCheck.match_method + ') — retry row deleted');
        }
      } else {
        // no_ground_truth or no_match. Two sub-paths: within window → upsert
        // retry; past cutoff → cutoff_with_ground_truth or
        // cutoff_no_ground_truth final-fail.
        var nextAt = new Date(Date.now() + 5 * 60 * 1000);
        if (wouldExceedFtbendCutoff(nextAt, 'America/Chicago')) {
          // CUTOFF — try one last ground-truth fetch if we don't already have one.
          var cutoffGT = (groundTruthArr && groundTruthArr.length > 0) ? groundTruthArr : null;
          if (!cutoffGT) {
            var lastFetch = await fetchFinishProbationGroundTruth(officeId).catch(function() { return { error: 'cutoff_fetch_failed' }; });
            cutoffGT = (lastFetch && lastFetch.testGroups && lastFetch.testGroups.length > 0) ? lastFetch.testGroups : null;
          }
          if (cutoffGT) {
            // cutoff_with_ground_truth — notify with disclaimer.
            var joined = cutoffGT.join(', ');
            config.result = joined;
            config.phase1 = cutoffGT[0];
            config.phase2 = cutoffGT[1] || null;
            config.verifiedViaFinishProbation = true;
            await storeFtbendColor(joined, transcript, officeId, cutoffGT[0], cutoffGT[1] || null);
            await notifyFtbendOfficeUsers(officeId, config);
            loggedMethod = 'cutoff_with_ground_truth';
            loggedGroundTruth = joined;
            console.log('[FTBEND-RETRY] Cutoff reached for ' + officeId + ' with ground truth — notified with disclaimer (attempt ' + thisAttemptNumber + ')');
          } else {
            // cutoff_no_ground_truth — final-fail.
            await finalFailFortBendOffice(officeId, thisAttemptNumber, ftbendOfficeHotline);
            loggedMethod = 'cutoff_no_ground_truth';
            console.log('[FTBEND-RETRY] Cutoff reached for ' + officeId + ' with no ground truth — final-fail (attempt ' + thisAttemptNumber + ')');
          }
          if (existingRetry) {
            await supabase.from('fort_bend_retries').delete().eq('id', existingRetry.id).then(function() {}, function(e) {
              console.error('[FTBEND-RETRY] delete-on-cutoff failed for ' + officeId + ':', e.message);
            });
          }
        } else {
          // WITHIN WINDOW — upsert retry row. NO notify, NO storeFtbendColor.
          // (Avoids dashboard UNKNOWN-flicker during the retry window.)
          var upsertData = {
            office: officeId,
            attempt_number: thisAttemptNumber,
            next_attempt_at: nextAt.toISOString(),
            last_call_sid: config.callSid || null,
            last_transcript: transcript,
            last_our_detection: ourDetection,
            last_ground_truth: loggedGroundTruth,
            updated_at: new Date().toISOString()
          };
          await supabase.from('fort_bend_retries').upsert(upsertData, { onConflict: 'office' }).then(function() {}, function(e) {
            console.error('[FTBEND-RETRY] upsert failed for ' + officeId + ':', e.message);
          });
          console.log('[FTBEND-RETRY] Queued retry for ' + officeId + ' at ' + nextAt.toISOString() + ' (attempt ' + thisAttemptNumber + ' resolved as ' + crossCheck.match_method + ', next will be ' + (thisAttemptNumber + 1) + ')');
        }
      }

      // ALWAYS log to fort_bend_learnings (best-effort). loggedMethod may have
      // been overridden by a cutoff branch above.
      await supabase.from('fort_bend_learnings').insert({
        date: ftbendLearningDate,
        office: officeId,
        hotline_number: ftbendOfficeHotline,
        raw_transcript: transcript,
        our_detection: ourDetection,
        ground_truth: loggedGroundTruth,
        match_method: loggedMethod,
        misrecognition_added: loggedMisrecognition,
        attempt_number: thisAttemptNumber
      }).then(function() {}, function(e) {
        console.error('[FTBEND-XCHECK] fort_bend_learnings insert failed for ' + officeId + ':', e.message);
      });
    } else {
      // Montgomery - detect test/no-test. PIN_EXPIRED check runs FIRST so an
      // expired-PIN announcement isn't accidentally classified as UNKNOWN
      // (or, in pathological mixed-audio transcripts, NO_TEST/MUST_TEST).
      var result = 'UNKNOWN';
      var isFtbend = config.county === 'ftbend';
      if (detectPinExpired(transcript)) {
        result = 'PIN_EXPIRED';
        console.log('[TRANSCRIBE] 🪪 PIN_EXPIRED detected for', callId);
        // Notification is sent ONLY at auto-disable, not on every occurrence —
        // a single mishear shouldn't spam the user. handlePinExpiredResult
        // increments the counter and decides whether to disable + notify.
        if (config.userId) {
          handlePinExpiredResult(config.userId, transcript, config.notifyNumber, config.notifyEmail, config.notifyMethod)
            .catch(function(e) { console.error('[PIN-EXPIRED] handler failed:', e.message); });
        } else {
          // Manual call with no userId (rare). Notify directly.
          await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, '⚠️ The hotline says your ID/PIN has expired. Please verify with your probation officer.\n\n- ProbationCall.com', callId);
        }
      } else if (KEYWORDS.MUST_TEST.some(function(k) { return lower.includes(k); })) {
        result = 'MUST_TEST';
        console.log('[TRANSCRIBE] 🚨 MUST TEST detected for', callId);
        var mustMsg = isFtbend
          ? '🚨 TEST REQUIRED! 🚨\n\nYour color was called. Report for testing today.\n\n- ProbationCall.com'
          : '🚨 TEST REQUIRED! 🚨\n\nYour PIN was called. You MUST test today.\n\nPIN: ' + config.pin + '\n\n- ProbationCall.com';
        await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, mustMsg, callId);
      } else if (KEYWORDS.NO_TEST.some(function(k) { return lower.includes(k); })) {
        result = 'NO_TEST';
        console.log('[TRANSCRIBE] ✅ No test detected for', callId);
        var noTestMsg = isFtbend
          ? '✅ No test today!\n\nYour color was NOT called. Enjoy your day!\n\n- ProbationCall.com'
          : '✅ No test today!\n\nYour PIN was NOT called. Enjoy your day!\n\nPIN: ' + config.pin + '\n\n- ProbationCall.com';
        await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, noTestMsg, callId);
      } else {
        console.log('[TRANSCRIBE] ⚠️ Unknown result for', callId, ':', transcript);
        if (config.isScheduledMorning && config.userId) {
          // Scheduled-morning retry flow — no notify, no streak, no row.
          // Handler decides whether to queue another retry or final-fail.
          await handleScheduledMorningNoResult(config, 'UNKNOWN', config.callSid, transcript, recordingUrl + '.mp3');
        } else {
          await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, '⚠️ Could not determine result.\n\nHeard: "' + transcript.substring(0, 100) + '"\n\nPlease call the hotline to verify.\n\n- ProbationCall.com', callId);
          // If this user has now had several UNKNOWNs in a row, pause their
          // schedule and alert them + admins. Catches non-PIN-expired
          // unparseable results (e.g. hotline wording changes).
          if (config.userId) {
            // Await BEFORE the call_history insert below so the streak SELECT
            // can't race with the INSERT and see today's row in the lookback.
            // .catch swallows errors so a check failure can't block the insert.
            await checkConsecutiveUnknown(config.userId, transcript, config.notifyNumber, config.notifyEmail, config.notifyMethod)
              .catch(function(e) { console.error('[UNKNOWN-STREAK] check failed:', e.message); });
          }
        }
      }

      // Deduct credit only on an actionable result. UNKNOWN does not bill.
      // Idempotency is durable: check whether any prior call_history row for
      // this call_sid already has billed_at set. If yes, we've billed this
      // call before (across restarts/redeploys too) and skip.
      var shouldMarkBilled = false;
      if ((result === 'MUST_TEST' || result === 'NO_TEST') && config.userId) {
        shouldMarkBilled = await deductCreditOnce(config.userId, 'call:' + (config.callSid || callId), {
          notifyNumber: config.notifyNumber,
          notifyEmail: config.notifyEmail,
          notifyMethod: config.notifyMethod,
          alreadyBilledCheck: async function() {
            if (!config.callSid) return false;
            var r = await supabase.from('call_history')
              .select('id')
              .eq('call_sid', config.callSid)
              .not('billed_at', 'is', null)
              .limit(1);
            if (r.error) throw r.error;
            return !!(r.data && r.data.length > 0);
          }
        });
      }

      config.result = result;
      // Suppress the per-attempt UNKNOWN row when this is a scheduled-morning
      // retry — handleScheduledMorningNoResult either queued the next attempt
      // (no row needed yet) or final-failed (already wrote ONE morning row).
      // MUST_TEST / NO_TEST / PIN_EXPIRED still write here as normal.
      var skipInsertForRetryFlow = config.isScheduledMorning && config.userId && result === 'UNKNOWN';
      if (config.userId && !skipInsertForRetryFlow) {
        var row = {
          user_id: config.userId,
          call_sid: config.callSid || 'unknown',
          target_number: config.targetNumber || '+19362834848',
          pin_used: config.pin,
          result: result,
          recording_url: recordingUrl + '.mp3',
          created_at: new Date().toISOString()
        };
        if (shouldMarkBilled) row.billed_at = new Date().toISOString();
        var insertResult = await supabase.from('call_history').insert(row);
        if (insertResult.error) {
          console.error('[TRANSCRIBE] INSERT ERROR:', JSON.stringify(insertResult.error));
        } else {
          console.log('[TRANSCRIBE] Saved result to call_history:', result, shouldMarkBilled ? '(billed)' : '');
        }
        // A confirmed result ends the morning — clean up any in-flight
        // retry sequence. Covers scheduled-morning AND manual paths (e.g.
        // user clicks "Call Now" mid-retry and gets an answer).
        if (!insertResult.error && (result === 'MUST_TEST' || result === 'NO_TEST' || result === 'PIN_EXPIRED')) {
          await supabase.from('pending_retries').delete().eq('user_id', config.userId).then(function() {}, function(e) {
            console.error('[RETRY] Failed to clean pending_retries on confirmed result:', e.message);
          });
        }
      }
      broadcastToClients({ type: 'result', callId: callId, result: result, speech: transcript });
    }
  } catch (err) {
    console.error('[TRANSCRIBE] Deepgram error:', err.message);
    if (!config.isFtbendDaily && config.notifyNumber) {
      await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, '⚠️ Call completed but no result detected.\n\nPlease verify manually.\nPIN: ' + config.pin + '\n\n- ProbationCall.com', callId);
    }
  }
});

// Cron job to delete old recordings (runs daily at 3am).
// Only nulls recording_url for rows whose Twilio delete actually succeeded
// — otherwise the DB and Twilio drift apart and stale URLs are unrecoverable.
cron.schedule('0 3 * * *', async function() {
  console.log('[CLEANUP] Deleting recordings older than 30 days...');
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  var old = await supabase.from('call_history')
    .select('id, recording_url')
    .lt('created_at', cutoff.toISOString())
    .not('recording_url', 'is', null);

  if (old.error) {
    console.error('[CLEANUP] Could not list old recordings:', old.error);
    return;
  }
  if (!old.data || old.data.length === 0) {
    console.log('[CLEANUP] Nothing to delete');
    return;
  }

  var deletedIds = [];
  var alreadyGoneIds = [];
  for (var i = 0; i < old.data.length; i++) {
    var row = old.data[i];
    var url = row.recording_url;
    var match = url ? url.match(/RE[a-f0-9]{32}/) : null;
    if (!match) {
      // Malformed/foreign URL — null it so it stops being retried.
      alreadyGoneIds.push(row.id);
      continue;
    }
    try {
      await twilioClient.recordings(match[0]).remove();
      console.log('[CLEANUP] Deleted recording', match[0]);
      deletedIds.push(row.id);
    } catch (e) {
      // Twilio returns 404 if the recording is already gone — also safe to null.
      if (e && (e.status === 404 || e.code === 20404)) {
        alreadyGoneIds.push(row.id);
      } else {
        console.log('[CLEANUP] Could not delete', match[0], e.message);
        // Leave the DB URL in place so we'll retry next day.
      }
    }
  }

  var toNull = deletedIds.concat(alreadyGoneIds);
  if (toNull.length > 0) {
    var upd = await supabase.from('call_history').update({ recording_url: null }).in('id', toNull);
    if (upd.error) console.error('[CLEANUP] Null update failed:', upd.error);
  }
  console.log('[CLEANUP] Done. Deleted: ' + deletedIds.length + ', already-gone: ' + alreadyGoneIds.length + ', retried: ' + (old.data.length - toNull.length));
}, { timezone: 'America/Chicago' });

// Gap 1: on a terminal Twilio failure, notify the user AND write a
// call_history row so the :45 recovery cron sees the user was handled
// today and doesn't fire a duplicate attempt. The recording webhook
// never fires for these statuses (no audio captured), so without this
// branch the user gets no SMS/email and the failure is invisible.
//
// 'completed' is NOT in this list — successful calls reach completed
// and the recording webhook handles them. failed/no-answer/busy/canceled
// are distinct Twilio terminal statuses that mean the call didn't
// connect or produce audio.
var TWILIO_TERMINAL_FAILURES = ['failed', 'no-answer', 'busy', 'canceled'];

app.post('/webhook/status', async function(req, res) {
  var callId = req.query.callId;
  var callStatus = req.body.CallStatus;
  log(callId, 'Status: ' + callStatus, 'info');
  var config = pendingCalls.get(callId);
  if (config) {
    config.status = callStatus;
    broadcastToClients({ type: 'status', callId: callId, status: callStatus });
  }
  // Always 200 quickly so Twilio doesn't retry on slow downstream work.
  res.sendStatus(200);

  // Only act on terminal failures; everything else (initiated, ringing,
  // answered, completed) is informational.
  if (!callStatus || TWILIO_TERMINAL_FAILURES.indexOf(callStatus) < 0) return;
  if (!config) return; // pendingCall expired or container restarted; nothing to act on
  if (config.failureHandled) return; // idempotency: one notify+insert per call
  config.failureHandled = true;

  // Ft Bend system calls and manual calls without a userId don't get
  // per-user handling. (Ft Bend failure handling is system-level and
  // outside the scope of this gap fix.)
  if (config.isFtbendDaily || !config.userId) {
    console.log('[STATUS] Terminal failure ' + callStatus + ' on Ft Bend / no-user call ' + callId + ' — skipping per-user notify/insert');
    return;
  }

  if (config.isScheduledMorning) {
    // Scheduled-morning retry flow — no notify (mid-retry silence), no
    // streak, no call_history row. Handler decides whether to queue
    // another retry or final-fail.
    await handleScheduledMorningNoResult(config, 'CALL_FAILED', config.callSid, '(no audio — Twilio status: ' + callStatus + ')', null);
    return;
  }

  var reason = callStatus === 'no-answer' ? 'the hotline did not answer'
             : callStatus === 'busy' ? 'the hotline line was busy'
             : callStatus === 'canceled' ? 'the call was canceled'
             : 'the call could not be completed';

  var msg = '⚠️ Call Issue\n\nYour scheduled check-in could not be completed — ' + reason + '. Please call the hotline manually to verify your status.' + (config.pin ? '\n\nPIN: ' + config.pin : '') + '\n\n- ProbationCall.com';
  try {
    await notify(config.notifyNumber, config.notifyEmail, config.notifyMethod, msg, callId);
  } catch (e) {
    console.error('[STATUS] notify failed for ' + callId + ':', e.message);
  }

  // Non-scheduled (manual/admin) path. Keep the d8bfe71 behavior:
  // notify, streak check, call_history row with result='CALL_FAILED',
  // billed_at NULL. Streak SELECT runs before INSERT (race-safe).
  await checkConsecutiveUnknown(config.userId, '(no audio — Twilio status: ' + callStatus + ')', config.notifyNumber, config.notifyEmail, config.notifyMethod)
    .catch(function(e) { console.error('[UNKNOWN-STREAK] check failed:', e.message); });

  var row = {
    user_id: config.userId,
    call_sid: config.callSid || 'unknown',
    target_number: config.targetNumber || '+19362834848',
    pin_used: config.pin,
    result: 'CALL_FAILED',
    created_at: new Date().toISOString()
  };
  var insertResult = await supabase.from('call_history').insert(row);
  if (insertResult.error) {
    console.error('[STATUS] CALL_FAILED insert error for ' + callId + ':', insertResult.error);
  } else {
    console.log('[STATUS] Recorded CALL_FAILED for ' + callId + ' user=' + config.userId.slice(0, 8) + ' status=' + callStatus);
  }
});

async function notify(phone, email, method, message, callId) {
  log(callId, 'Notifying via ' + method, 'info');
  
  if (method === 'email' && email) {
    return await sendEmail(email, message, callId);
  }
  if (method === 'sms' && phone) {
    return await sendSMS(phone, message, callId);
  }
  if (method === 'both') {
    var results = [];
    if (email) results.push(await sendEmail(email, message, callId));
    if (phone) results.push(await sendSMS(phone, message, callId));
    return { success: results.some(function(r) { return r.success; }) };
  }
  if (method === 'whatsapp' && phone) {
    return await sendWhatsApp(phone, message, callId);
  }
  
  log(callId, 'No valid notification method', 'error');
  return { success: false, error: 'No notification method' };
}


async function sendEmail(to, message, callId) {
  if (!process.env.BREVO_KEY) {
    log(callId, "Brevo not configured", "error");
    return { success: false, error: "Email not configured" };
  }

  // Date-stamp the subject so Gmail doesn't bundle today's notification
  // into yesterday's thread. Excluded: one-off transactional emails (test,
  // low-credit) where threading isn't a problem. (Welcome emails use a
  // separate path that bypasses this function entirely.)
  var stamp = (callId === 'test' || callId === 'low_credit') ? '' : ' (' + todayMD() + ')';

  var subject = "ProbationCall Alert" + stamp;
  var headerColor = "#00d9ff";
  var resultBadge = "";
  var headerEmoji = "📞";

  if (message.includes("MUST TEST") || message.includes("TEST REQUIRED")) {
    subject = "🚨 TEST REQUIRED TODAY" + stamp + " - ProbationCall";
    headerColor = "#ef4444";
    resultBadge = "<div style='background:#ef4444;color:#fff;padding:15px 25px;border-radius:8px;font-size:20px;font-weight:bold;text-align:center;margin:20px 0'>⚠️ YOU MUST TEST TODAY</div>";
    headerEmoji = "🚨";
  } else if (message.includes("NO_TEST") || message.includes("No test today") || message.includes("do NOT need to test")) {
    subject = "✅ No Test Today" + stamp + " - ProbationCall";
    headerColor = "#22c55e";
    resultBadge = "<div style='background:#22c55e;color:#fff;padding:15px 25px;border-radius:8px;font-size:20px;font-weight:bold;text-align:center;margin:20px 0'>✅ NO TEST REQUIRED</div>";
    headerEmoji = "✅";
  } else if (message.includes("Fort Bend") || message.includes("Color")) {
    subject = "🎨 Fort Bend Color Update" + stamp + " - ProbationCall";
    headerColor = "#f59e0b";
    headerEmoji = "🎨";
  }
  
  var html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"></head>" +
    "<body style=\"margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\">" +
    "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f4f4f5;padding:20px 0;\">" +
    "<tr><td align=\"center\">" +
    "<table width=\"500\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:500px;background:#0a0a1a;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.15);\">" +
    "<tr><td style=\"background:#ffffff;padding:25px;text-align:center;\">" +
    "<img src=\"https://i.imgur.com/6ZPpeQW.png\" alt=\"ProbationCall\" style=\"width:150px;height:auto;display:block;margin:0 auto;border-radius:8px;\" />" +
    "</td></tr>" +
    "<tr><td style=\"padding:30px;background:#0a0a1a;\">" + resultBadge +
    "<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;margin:15px 0;\">" +
    "<tr><td style=\"padding:20px;\">" +
    "<p style=\"margin:0;color:#e4e4e7;font-size:16px;line-height:1.6;white-space:pre-line;\">" + message + "</p>" +
    "</td></tr></table>" +
    "<p style=\"margin:20px 0 0;color:#71717a;font-size:13px;text-align:center;\">This is an automated message from ProbationCall</p>" +
    "</td></tr>" +
    "<tr><td style=\"background:rgba(255,255,255,0.03);padding:15px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);\">" +
    "<a href=\"https://probationcall.com\" style=\"color:#00d9ff;text-decoration:none;font-size:14px;\">probationcall.com</a>" +
    "</td></tr>" +
    "</table>" +
    "</td></tr></table></body></html>";
  try {
    await brevoMail.send({
      to: to,
      from: { email: FROM_EMAIL, name: "ProbationCall" },
      subject: subject,
      text: message,
      html: html
    });
    log(callId, "Email sent to " + to, "success");
    return { success: true };
  } catch (e) {
    log(callId, "Email failed: " + e.message, "error");
    return { success: false, error: e.message };
  }
}


async function sendSMS(to, message, callId) {
  try {
    var msg = await twilioClient.messages.create({ 
      messagingServiceSid: MESSAGING_SERVICE_SID, 
      to: to, 
      body: message 
    });
    log(callId, 'SMS sent: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, 'SMS failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

async function sendWhatsApp(to, message, callId) {
  var toWA = to.indexOf('whatsapp:') === 0 ? to : 'whatsapp:' + to;
  try {
    var msg = await twilioClient.messages.create({ 
      from: WHATSAPP_NUMBER, 
      to: toWA, 
      body: message 
    });
    log(callId, 'WhatsApp sent: ' + msg.sid, 'success');
    return { success: true, sid: msg.sid };
  } catch (e) {
    log(callId, 'WhatsApp failed: ' + e.message, 'error');
    return { success: false, error: e.message };
  }
}

// === WELCOME MESSAGE ===
async function sendWelcomeEmail(email, credits, callId) {
  var subject = 'Welcome To ProbationCall';
  var message = 'Welcome to ProbationCall!' +
    '\n\nYour account is set up and ready to go. You have ' + credits + ' free credits to get started.' +
    '\n\nNext steps:' +
    '\n1. Set up your daily schedule' +
    '\n2. Enter your PIN and notification preferences' +
    '\n3. We handle the rest - you get notified only when you need to test' +
    '\n\nQuestions? Reply to this email anytime.' +
    '\n\n- The ProbationCall Team' +
    '\nhttps://probationcall.com';
  try {
    await brevoMail.send({
      to: email,
      from: { email: FROM_EMAIL, name: 'ProbationCall' },
      subject: subject,
      text: message,
      html: message.replace(/\n/g, '<br>')
    });
    console.log('[WELCOME] Email sent to ' + email);
  } catch (e) {
    console.error('[WELCOME] Email failed:', e.message);
  }
}

// === LOW CREDIT ALERT ===
async function sendLowCreditAlert(userId, remainingCredits, notifyNumber, notifyEmail, notifyMethod) {
  if (remainingCredits > 2 || remainingCredits < 0) return;
  var message;
  if (remainingCredits <= 1) {
    message = '🚨 Low Credits Warning!\n\nYou only have ' + remainingCredits + ' credit(s) left! After that, your daily check-ins STOP and you could miss a required test.\n\nPurchase credits now at:\nprobationcall.com\n\n- ProbationCall.com';
  } else {
    message = '⚠️ Credits Running Low\n\nYou have ' + remainingCredits + ' credits remaining. Running out means missed check-ins.\n\nPurchase credits at:\nprobationcall.com\n\n- ProbationCall.com';
  }
  console.log('[LOW-CREDIT] Alerting user ' + userId.slice(0,8) + '... (' + remainingCredits + ' credits left)');
  if (notifyNumber) {
    await sendSMS(notifyNumber, message, 'low_credit').catch(function(e) { console.error('[LOW-CREDIT] SMS failed:', e.message); });
  }
  if (notifyEmail) {
    await sendEmail(notifyEmail, message, 'low_credit').catch(function(e) { console.error('[LOW-CREDIT] Email failed:', e.message); });
  }
}

app.post('/api/test-email', auth, rateLimit('test-email', 3, 5 * 60 * 1000), async function(req, res) {
  var result = await sendEmail(req.body.email, '✅ Test email from ProbationCall!\n\nIf you see this, email notifications are working.', 'test');
  res.json(result);
});

app.post('/api/test-sms', auth, rateLimit('test-sms', 3, 5 * 60 * 1000), async function(req, res) {
  var result = await sendSMS(req.body.notifyNumber, 'Test SMS from ProbationCall!', 'test');
  res.json(result);
});

app.post('/api/test-whatsapp', auth, rateLimit('test-whatsapp', 3, 5 * 60 * 1000), async function(req, res) {
  var result = await sendWhatsApp(req.body.notifyNumber, '✅ Test WhatsApp from ProbationCall!\n\nIf you see this, WhatsApp notifications are working.', 'test');
  res.json(result);
});

wss.on('connection', async function(ws, req) {
  // Only accept /ws connections with a valid Supabase access token in the
  // query string. We tag the socket with userId so broadcastToClients can
  // route per-call events to only that user.
  try {
    var url = req.url || '';
    if (url.indexOf('/ws') !== 0) {
      ws.close(1008, 'bad path');
      return;
    }
    var qIndex = url.indexOf('?');
    var query = qIndex >= 0 ? url.slice(qIndex + 1) : '';
    var params = new URLSearchParams(query);
    var token = params.get('token');
    if (!token) {
      ws.close(1008, 'auth required');
      return;
    }
    var authRes = await supabase.auth.getUser(token);
    if (authRes.error || !authRes.data || !authRes.data.user) {
      ws.close(1008, 'invalid token');
      return;
    }
    ws.userId = authRes.data.user.id;
    wsClients.add(ws);
    ws.on('close', function() { wsClients.delete(ws); });
  } catch (e) {
    console.error('[WS] connection auth error:', e.message);
    try { ws.close(1011, 'server error'); } catch (_) {}
  }
});


// Mass text all active users
app.post('/api/admin/mass-text', adminAuth, async function(req, res) {
  try {
    var message = req.body.message;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    
    // Get all active schedules with notify numbers
    var result = await supabase.from('user_schedules').select('user_id, notify_number, notify_email, notify_method').eq('enabled', true);
    var schedules = result.data || [];
    
    var sent = 0, failed = 0, skipped = 0;
    var fullMessage = message.trim() + '\n\n- ProbationCall.com';
    
    for (var i = 0; i < schedules.length; i++) {
      var s = schedules[i];
      if (!s.notify_number) { skipped++; continue; }
      try {
        await sendSMS(s.notify_number, fullMessage, 'mass_text');
        sent++;
        // Small delay to avoid rate limiting
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      } catch (e) {
        console.error('[MASS TEXT] Failed for', s.user_id, e.message);
        failed++;
      }
    }
    
    console.log('[MASS TEXT] Sent:', sent, 'Failed:', failed, 'Skipped:', skipped);
    res.json({ success: true, sent: sent, failed: failed, skipped: skipped, total: schedules.length });
  } catch (e) {
    console.error('[MASS TEXT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin alert — fires when Montgomery users whose scheduled time has already
// passed (plus stagger + grace) haven't produced a call_history row today.
// Excludes Fort Bend (handled separately by the 5:05 system call) and counts
// NO_CREDITS / UNKNOWN as "ran" — they did, just without an actionable result.
var adminAlertSent = false;
var adminAlertDate = null;
var HEALTH_GRACE_MINUTES = STAGGER_MINUTES + 20; // stagger window + 20 min buffer
async function checkCallHealth() {
  try {
    var now = new Date();
    var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');

    if (adminAlertDate !== today) {
      adminAlertSent = false;
      adminAlertDate = today;
    }
    if (adminAlertSent) return;

    var hour = cst.getHours();
    if (hour < 7 || hour > 11) return;
    var nowMinutes = hour * 60 + cst.getMinutes();

    var schedResult = await supabase.from('user_schedules')
      .select('user_id, hour, minute, county')
      .eq('enabled', true)
      .neq('county', 'ftbend'); // Fort Bend doesn't generate per-user calls
    var enabled = schedResult.data || [];
    if (enabled.length === 0) return;

    // Only consider schedules whose target time has passed by ≥ grace.
    var due = enabled.filter(function(s) {
      var schedMinutes = (s.hour || 6) * 60 + (s.minute || 0);
      return (nowMinutes - schedMinutes) >= HEALTH_GRACE_MINUTES;
    });
    if (due.length === 0) return;
    var dueUserIds = due.map(function(s) { return s.user_id; });

    // "Ran" = any call_history row for this user today, regardless of result.
    // NO_CREDITS users were intentionally skipped and were notified — those
    // count as handled. Only RETRY_PENDING means "still in flight".
    var callResult = await supabase.from('call_history')
      .select('user_id, result')
      .gte('created_at', today + 'T00:00:00')
      .lte('created_at', today + 'T23:59:59')
      .in('user_id', dueUserIds);
    var calls = callResult.data || [];
    var ranUserIds = {};
    calls.forEach(function(c) {
      if (c.result !== 'RETRY_PENDING') ranUserIds[c.user_id] = true;
    });

    var missed = due.filter(function(s) { return !ranUserIds[s.user_id]; });

    // Only alert if a meaningful fraction is missing AND it's at least 3 users.
    if (missed.length < 3) return;
    if (missed.length / due.length < 0.25) return;

    var adminResult = await supabase.from('profiles').select('id').eq('is_admin', true);
    var admins = adminResult.data || [];
    for (var i = 0; i < admins.length; i++) {
      var adminSched = await supabase.from('user_schedules').select('notify_number').eq('user_id', admins[i].id).single();
      if (adminSched.data && adminSched.data.notify_number) {
        await sendSMS(adminSched.data.notify_number,
          '⚠️ ADMIN ALERT: Possible call issues!\n\n' +
          'Due (Montgomery, past scheduled time): ' + due.length + '\n' +
          'Ran: ' + Object.keys(ranUserIds).length + '\n' +
          'Missed: ' + missed.length + '\n\n' +
          'Check admin panel.\n\n- ProbationCall.com',
          'admin_alert').catch(function(e) { console.error('[ADMIN ALERT] SMS failed:', e.message); });
      }
    }
    adminAlertSent = true;
    console.log('[ADMIN ALERT] Call health warning sent — due=' + due.length + ' ran=' + Object.keys(ranUserIds).length + ' missed=' + missed.length);
  } catch (e) {
    console.error('[ADMIN ALERT] checkCallHealth error:', e.message);
  }
}

// Run health check every 30 minutes
setInterval(checkCallHealth, 30 * 60 * 1000);

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('========================================');
  console.log('ProbationCall Server Running');
  console.log('Port: ' + PORT);
  console.log('Voice: ' + TWILIO_VOICE_NUMBER);
  console.log('Email: ' + (process.env.BREVO_KEY ? 'Brevo configured' : 'Not configured'));
  console.log('SMS: Messaging Service ' + MESSAGING_SERVICE_SID);
  console.log('WhatsApp: ' + WHATSAPP_NUMBER);
  console.log('Call Hours: ' + MIN_HOUR + ':00 AM - ' + MAX_HOUR + ':59 PM');
  console.log('Stagger Window: ' + STAGGER_MINUTES + ' minutes');
  console.log('Affiliate Commission: ' + AFFILIATE_COMMISSION_PERCENT + '%');
  console.log('Affiliate program: ' + (AFFILIATE_ENABLED ? 'ENABLED' : 'disabled (set AFFILIATE_ENABLED=true to enable)'));
  console.log('Min Payout: $' + (MIN_PAYOUT_CENTS / 100));
  console.log('========================================');
  loadAllSchedules();
});
// ========== ADMIN ROUTES ==========

async function adminAuth(req, res, next) {
  var authHeader = req.headers.authorization;
  var tkn = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!tkn) return res.status(401).json({ error: 'No token' });
  try {
    var result = await supabase.auth.getUser(tkn);
    if (result.error || !result.data.user) return res.status(401).json({ error: 'Invalid' });
    var pr = await supabase.from('profiles').select('*').eq('id', result.data.user.id).single();
    if (!pr.data || !pr.data.is_admin) return res.status(403).json({ error: 'Not admin' });
    req.user = result.data.user;
    req.profile = pr.data;
    // Track last login
    supabase.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", result.data.user.id);
    next();
  } catch(e) {
    res.status(500).json({ error: 'Auth error' });
  }
}

app.get('/api/admin/check', auth, async function(req, res) {
  res.json({ isAdmin: req.profile.is_admin === true });
});

app.get('/api/admin/dashboard', adminAuth, async function(req, res) {
  try {
    var usersResult = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    var users = usersResult.data || [];
    
    // Get auth users data for created_at and last_sign_in_at
    var authUsersResult = await supabase.auth.admin.listUsers();
    var authUsers = authUsersResult.data ? authUsersResult.data.users : [];
    
    // Merge auth data into profiles
    users = users.map(function(u) {
      var authUser = authUsers.find(function(a) { return a.id === u.id; });
      if (authUser) {
        u.auth_created_at = authUser.created_at;
        u.last_sign_in_at = authUser.last_sign_in_at;
      }
      return u;
    });
    
    var schedulesResult = await supabase.from('user_schedules').select('*');
    var schedules = schedulesResult.data || [];
    
    var callsResult = await supabase.from('call_history').select('*, profiles(email)').order('created_at', { ascending: false }).limit(2000);
    var calls = (callsResult.data || []).map(function(c) {
      return Object.assign({}, c, { user_email: c.profiles ? c.profiles.email : null });
    });
    
    var purchasesResult = await supabase.from('purchases').select('*, profiles(email)').order('created_at', { ascending: false }).limit(500);
    var purchases = (purchasesResult.data || []).map(function(p) {
      return Object.assign({}, p, { user_email: p.profiles ? p.profiles.email : null });
    });
    
    var payoutsResult = await supabase.from('payout_requests').select('*, profiles(email)').order('created_at', { ascending: false });
    var payouts = (payoutsResult.data || []).map(function(p) {
      return Object.assign({}, p, { user_email: p.profiles ? p.profiles.email : null });
    });
    
    var promosResult = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    var promos = promosResult.data || [];
    
    var totalRevenue = 0;
    for (var i = 0; i < purchases.length; i++) {
      totalRevenue += purchases[i].amount_cents || 0;
    }
    
    var pendingPayouts = 0;
    for (var i = 0; i < payouts.length; i++) {
      if (payouts[i].status === 'pending') pendingPayouts++;
    }
    
    var affiliateOwed = 0;
    for (var i = 0; i < users.length; i++) {
      affiliateOwed += users[i].affiliate_balance_cents || 0;
    }
    
    var termsAgreed = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i].terms_accepted_at) termsAgreed++;
    }
    
    var disabledUsers = 0;
    for (var i = 0; i < users.length; i++) {
      if (users[i].is_disabled) disabledUsers++;
    }
    
    var activeSchedules = 0;
    for (var i = 0; i < schedules.length; i++) {
      if (schedules[i].enabled) activeSchedules++;
    }
    
    res.json({
      stats: {
        totalUsers: users.length,
        activeSchedules: activeSchedules,
        totalCalls: calls.length,
        totalRevenue: totalRevenue,
        pendingPayouts: pendingPayouts,
        affiliateOwed: affiliateOwed,
        termsAgreed: termsAgreed,
        disabledUsers: disabledUsers
      },
      users: users,
      schedules: schedules,
      calls: calls,
      purchases: purchases,
      payouts: payouts,
      promos: promos
    });
  } catch(e) {
    console.error('Admin error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/credits', adminAuth, async function(req, res) {
  try {
    var userId = req.params.id;
    var action = req.body.action;
    var amount = parseInt(req.body.amount) || 0;
    var ur = await supabase.from('profiles').select('credits, email').eq('id', userId).single();
    var curr = ur.data ? (ur.data.credits || 0) : 0;
    var targetEmail = ur.data ? ur.data.email : null;
    var newC;
    if (action === 'add') {
      newC = curr + amount;
    } else if (action === 'remove') {
      newC = Math.max(0, curr - amount);
    } else if (action === 'set') {
      newC = amount;
    } else {
      newC = curr;
    }
    var delta = newC - curr;
    if (delta > 0) {
      // Atomic balance-update + ledger entry via RPC. Records who did it.
      var resultBalance = await recordCreditAdd({
        userId: userId,
        amount: delta,
        source: 'admin_grant',
        note: 'Admin ' + action + ' (' + curr + ' -> ' + newC + ')',
        performedBy: req.profile && req.profile.email ? req.profile.email : null
      });
      if (resultBalance === null) {
        return res.status(500).json({ error: 'Credit grant failed — ledger not updated' });
      }
    } else if (delta < 0) {
      // Deduction (admin lowered balance). Not tracked in the credit ledger
      // per current scope — the ledger records adds only.
      var dedUpd = await supabase.from('profiles').update({ credits: newC }).eq('id', userId);
      if (dedUpd.error) return res.status(500).json({ error: dedUpd.error.message });
    }
    console.log('[ADMIN] Credits updated by ' + (req.profile && req.profile.email ? req.profile.email : 'unknown') + ': ' + userId.slice(0,8) + ' (' + (targetEmail || '?') + ') ' + curr + ' -> ' + newC);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/admin', adminAuth, async function(req, res) {
  try {
    await supabase.from('profiles').update({ is_admin: req.body.isAdmin }).eq('id', req.params.id);
    console.log('[ADMIN] Admin status changed: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/user/:id/disable', adminAuth, async function(req, res) {
  try {
    await supabase.from('profiles').update({ is_disabled: req.body.disabled }).eq('id', req.params.id);
    console.log('[ADMIN] Disabled status changed: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/trigger-ftbend', adminAuth, async function(req, res) {
  console.log('[FTBEND] Manual trigger by admin');
  ftbendDailyColorCall();
  res.json({ success: true, message: 'Fort Bend call triggered' });
});

// Manually trigger a call for a specific user
app.post('/api/admin/trigger-call/:userId', adminAuth, async function(req, res) {
  var userId = req.params.userId;
  
  var schedResult = await supabase.from('user_schedules')
    .select('*')
    .eq('user_id', userId)
    .single();
  
  if (!schedResult.data) {
    return res.status(400).json({ error: 'User has no schedule' });
  }
  
  var sched = schedResult.data;
  console.log('[ADMIN] Triggering call for user ' + userId.slice(0,8) + ' county: ' + sched.county);
  
  if (sched.county === 'ftbend') {
    var now = new Date();
    var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
    
    var colorResult = await supabase.from('daily_county_status')
      .select('color')
      .eq('county', 'ftbend')
      .eq('date', today)
      .single();
    
    var color = colorResult.data ? colorResult.data.color : 'UNKNOWN';
    var message = color === 'UNKNOWN'
      ? '⚠️ ProbationCall: Could not detect today\'s color. Please call +1 (281) 238-3669'
      : '🎨 Fort Bend Color: ' + color.toUpperCase() + '\n\nCheck if this is your assigned color.';
    
    await notify(sched.notify_number, sched.notify_email, sched.notify_method, message, 'admin_trigger');
    console.log('[ADMIN] Sent Fort Bend notification to ' + userId.slice(0,8));
    res.json({ success: true, message: 'Fort Bend notification sent with color: ' + color });
  } else {
    try {
      await initiateCall(
        sched.target_number,
        sched.pin,
        sched.notify_number,
        sched.notify_email,
        sched.notify_method,
        userId,
        0,
        sched.county
      );
      console.log('[ADMIN] Initiated Montgomery call for ' + userId.slice(0,8));
      res.json({ success: true, message: 'Call initiated for Montgomery County' });
    } catch (e) {
      console.error('[ADMIN] Call failed:', e);
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/api/admin/toggle-ftbend', adminAuth, async function(req, res) {
  var userId = req.body.userId;
  var enable = req.body.enable;
  
  var result = await supabase.from('profiles')
    .update({ ftbend_access: enable })
    .eq('id', userId);
  
  if (result.error) {
    console.error('[ADMIN] Toggle ftbend error:', result.error);
    return res.status(500).json({ error: result.error.message });
  }
  res.json({ success: true, ftbend_access: enable });
});

// §3 + §6.D: list affiliate_earnings rows that need admin attention.
// Returns two arrays:
//   failed          — Stripe transfer never succeeded; retryable via the
//                     /retry endpoint once the affiliate's account is ready.
//   reversal_failed — Refund/dispute clawback couldn't recover the money
//                     (affiliate already withdrew). NOT retryable from this
//                     endpoint; admin handles out-of-band.
// Joined with the affiliate's profile (email, current connect_id). Newest first.
app.get('/api/admin/affiliate-earnings/failed', adminAuth, requireAffiliateEnabled, async function(req, res) {
  var r = await supabase.from('affiliate_earnings')
    .select('id, affiliate_id, referred_id, amount_cents, purchase_amount_cents, status, error_message, created_at, profiles!affiliate_id(email, stripe_connect_id)')
    .in('status', ['failed', 'reversal_failed'])
    .order('created_at', { ascending: false })
    .limit(500);
  if (r.error) {
    console.error('[ADMIN] List failed earnings error:', r.error);
    return res.status(500).json({ error: r.error.message });
  }
  var rows = r.data || [];
  res.json({
    failed: rows.filter(function(x) { return x.status === 'failed'; }),
    reversal_failed: rows.filter(function(x) { return x.status === 'reversal_failed'; })
  });
});

// §3: retry a single failed transfer. Reads the affiliate's CURRENT
// stripe_connect_id (in case it changed since the original attempt) and
// retries with a fresh idempotency key. On success the row flips to
// 'transferred' with the new stripe_transfer_id; on failure error_message
// is updated and status stays 'failed' for another retry.
app.post('/api/admin/affiliate-earnings/:id/retry', adminAuth, requireAffiliateEnabled, async function(req, res) {
  var id = req.params.id;
  var r = await supabase.from('affiliate_earnings')
    .select('id, status, amount_cents, profiles!affiliate_id(stripe_connect_id, email)')
    .eq('id', id)
    .single();
  if (r.error || !r.data) {
    return res.status(404).json({ error: 'Earnings row not found' });
  }
  var earning = r.data;
  if (earning.status !== 'failed') {
    return res.status(400).json({ error: 'Row is not in failed state (current: ' + earning.status + ')' });
  }
  var destAcct = earning.profiles && earning.profiles.stripe_connect_id;
  if (!destAcct) {
    return res.status(400).json({ error: 'Affiliate no longer has a Stripe Connect account on file' });
  }

  // §6.B — same pre-flight as the commission block. Don't waste a Stripe
  // call (and produce a misleading error message) if the account still
  // isn't ready. Returns 400 with a clear message so admin knows the
  // affiliate's onboarding is the blocker, not a transient Stripe issue.
  var connectStatus = await getConnectAccountStatus(destAcct);
  if (connectStatus) {
    await syncConnectStatusToProfile(destAcct, connectStatus);
  }
  if (!connectStatus) {
    var apiErr = 'Could not verify Connect account status (Stripe API error). Try again in a moment.';
    await supabase.from('affiliate_earnings').update({ error_message: apiErr }).eq('id', id);
    return res.status(503).json({ error: apiErr });
  }
  if (!connectStatus.payouts_enabled) {
    var notReadyMsg = 'Connect account still not payouts_enabled (charges_enabled=' + connectStatus.charges_enabled + ', details_submitted=' + connectStatus.details_submitted + '). Affiliate needs to complete Stripe onboarding before retry will succeed.';
    await supabase.from('affiliate_earnings').update({ error_message: notReadyMsg }).eq('id', id);
    return res.status(400).json({ error: notReadyMsg });
  }

  try {
    var transfer = await stripe.transfers.create({
      amount: earning.amount_cents,
      currency: 'usd',
      destination: destAcct,
      description: 'Affiliate commission for referral (admin retry)'
    }, {
      // Per-retry idempotency key so each click is a fresh Stripe request.
      // Stripe still dedupes if the same key is replayed within 24h.
      idempotencyKey: 'aff-earning-retry-' + earning.id + '-' + Date.now()
    });
    await supabase.from('affiliate_earnings').update({
      status: 'transferred',
      stripe_transfer_id: transfer.id,
      error_message: null
    }).eq('id', id);
    console.log('[CONNECT] Admin retry SUCCESS for earning ' + id + ' (' + (earning.profiles && earning.profiles.email) + ') tr=' + transfer.id);
    res.json({ success: true, transfer_id: transfer.id });
  } catch (te) {
    var msg = te && te.message ? te.message : String(te);
    await supabase.from('affiliate_earnings').update({ error_message: msg }).eq('id', id);
    console.error('[CONNECT] Admin retry FAILED for earning ' + id + ':', msg);
    res.status(500).json({ error: msg });
  }
});

// Set custom referral code for affiliates
app.post('/api/admin/set-referral-code', adminAuth, requireAffiliateEnabled, async function(req, res) {
  var userId = req.body.userId;
  var code = req.body.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  if (code.length < 3 || code.length > 15) {
    return res.status(400).json({ error: 'Code must be 3-15 characters' });
  }
  
  // Check if code already exists
  var existing = await supabase.from('profiles')
    .select('id')
    .eq('referral_code', code)
    .neq('id', userId)
    .single();
  
  if (existing.data) {
    return res.status(400).json({ error: 'Code already in use' });
  }
  
  var result = await supabase.from('profiles')
    .update({ referral_code: code })
    .eq('id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Set referral code for ' + userId.slice(0,8) + ': ' + code);
  res.json({ success: true, code: code });
});

// Unlock user from affiliate
app.post('/api/admin/set-lock', adminAuth, requireAffiliateEnabled, async function(req, res) {
  var { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'Missing userId or code' });
  var { error } = await supabase.from('profiles').update({ referred_by: code.toUpperCase() }).eq('id', userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/unlock-user', adminAuth, requireAffiliateEnabled, async function(req, res) {
  var userId = req.body.userId;
  
  var result = await supabase.from('profiles')
    .update({ referred_by: null })
    .eq('id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Unlocked user ' + userId.slice(0,8) + ' from affiliate');
  res.json({ success: true });
});

// Delete user schedule
app.delete('/api/admin/schedule/:userId', adminAuth, async function(req, res) {
  var userId = req.params.userId;
  
  var result = await supabase.from('user_schedules')
    .delete()
    .eq('user_id', userId);
  
  if (result.error) {
    return res.status(500).json({ error: result.error.message });
  }
  
  console.log('[ADMIN] Deleted schedule for user ' + userId.slice(0,8));
  res.json({ success: true });
});

app.post('/api/admin/payout/:id', adminAuth, async function(req, res) {
  try {
    await supabase.from('payout_requests').update({
      status: req.body.status,
      processed_at: new Date().toISOString()
    }).eq('id', req.params.id);
    console.log('[ADMIN] Payout processed: ' + req.params.id.slice(0,8) + ' -> ' + req.body.status);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/promo', adminAuth, async function(req, res) {
  try {
    await supabase.from('promo_codes').insert({
      code: req.body.code.toUpperCase(),
      credits: req.body.credits,
      max_uses: req.body.maxUses,
      times_used: 0
    });
    console.log('[ADMIN] Promo created: ' + req.body.code);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/promo/:id', adminAuth, async function(req, res) {
  try {
    await supabase.from('promo_codes').delete().eq('id', req.params.id);
    console.log('[ADMIN] Promo deleted: ' + req.params.id.slice(0,8));
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



app.get("/api/admin/user/:id/calls", adminAuth, async function(req, res) {
  var result = await supabase.from("call_history").select("*").eq("user_id", req.params.id).order("created_at", { ascending: false }).limit(500);
  res.json({ calls: result.data || [] });
});

app.get("/api/admin/user/:id/credit-history", adminAuth, async function(req, res) {
  var result = await supabase.from("credit_transactions")
    .select("*")
    .eq("user_id", req.params.id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ history: result.data || [] });
});
app.delete('/api/admin/user/:id', adminAuth, async function(req, res) {
  var userId = req.params.id;
  console.log('[ADMIN] Deleting user: ' + userId);

  // Run each delete and collect any failures. We continue past a failure so
  // the rest still tries — but we report all failures back so admin knows
  // the user is in a partial state and can investigate.
  var failures = [];
  async function step(label, promise) {
    try {
      var result = await promise;
      if (result && result.error) {
        failures.push(label + ': ' + result.error.message);
        console.error('[ADMIN] Delete step failed: ' + label, result.error);
      } else {
        console.log('[ADMIN] Deleted ' + label);
      }
    } catch (e) {
      failures.push(label + ': ' + e.message);
      console.error('[ADMIN] Delete step threw: ' + label, e);
    }
  }

  await step('user_schedules', supabase.from('user_schedules').delete().eq('user_id', userId));
  await step('call_history', supabase.from('call_history').delete().eq('user_id', userId));
  await step('purchases', supabase.from('purchases').delete().eq('user_id', userId));
  await step('payout_requests', supabase.from('payout_requests').delete().eq('user_id', userId));
  await step('referrals(referrer)', supabase.from('referrals').delete().eq('referrer_id', userId));
  await step('referrals(referred)', supabase.from('referrals').delete().eq('referred_id', userId));
  await step('affiliate_earnings(affiliate)', supabase.from('affiliate_earnings').delete().eq('affiliate_id', userId));
  await step('affiliate_earnings(referred)', supabase.from('affiliate_earnings').delete().eq('referred_id', userId));
  await step('promo_redemptions', supabase.from('promo_redemptions').delete().eq('user_id', userId));
  await step('profiles', supabase.from('profiles').delete().eq('id', userId));

  var authResult = await supabase.auth.admin.deleteUser(userId);
  if (authResult.error) {
    failures.push('auth: ' + authResult.error.message);
    console.error('[ADMIN] Auth delete error:', authResult.error);
  } else {
    console.log('[ADMIN] Deleted from auth');
  }

  if (scheduledJobs.has(userId)) {
    scheduledJobs.get(userId).stop();
    scheduledJobs.delete(userId);
    console.log('[ADMIN] Stopped scheduled job');
  }

  if (failures.length > 0) {
    console.error('[ADMIN] User ' + userId.slice(0,8) + ' deleted with ' + failures.length + ' failures:', failures);
    return res.status(500).json({ success: false, error: 'Partial delete', failures: failures });
  }
  console.log('[ADMIN] Successfully deleted user: ' + userId.slice(0,8));
  res.json({ success: true });
});

app.get('/admin', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========== END ADMIN ROUTES ==========



// ========== FT BEND DAILY COLOR SYSTEM ==========

// ========== FT BEND MULTI-OFFICE DAILY COLOR SYSTEM ==========

// Call all 3 Fort Bend offices
async function ftbendDailyColorCall() {
  console.log('[FTBEND] Starting daily color detection for ALL offices...');
  
  var offices = Object.keys(FTBEND_OFFICES);
  for (var i = 0; i < offices.length; i++) {
    var officeId = offices[i];
    var office = FTBEND_OFFICES[officeId];
    
    // Stagger calls by 30 seconds each
    (function(oid, off) {
      setTimeout(function() {
        ftbendCallOffice(oid, off);
      }, i * 30000);
    })(officeId, office);
  }
}

// Call a single Fort Bend office
async function ftbendCallOffice(officeId, office) {
  var callId = 'ftbend_' + officeId + '_' + Date.now();
  console.log('[FTBEND] Calling ' + office.name + ' (' + office.number + ')...');
  
  pendingCalls.set(callId, {
    isFtbendDaily: true,
    officeId: officeId,
    officeName: office.name,
    targetNumber: office.number,
    hasPhases: office.hasPhases || false,
    result: null,
    phase1: null,
    phase2: null
  });
  
  try {
    var call = await twilioClient.calls.create({
      to: office.number,
      from: TWILIO_VOICE_NUMBER,
      url: process.env.BASE_URL + '/twiml/ftbend-answer?callId=' + callId + '&officeId=' + officeId,
      statusCallback: process.env.BASE_URL + '/webhook/status?callId=' + callId,
      record: true,
      recordingStatusCallback: process.env.BASE_URL + '/webhook/recording?callId=' + callId,
      timeout: 60
    });
    
    pendingCalls.get(callId).callSid = call.sid;
    console.log('[FTBEND] ' + office.name + ' call initiated: ' + call.sid);
  } catch (e) {
    console.error('[FTBEND] ' + office.name + ' call failed:', e.message);
  }
}

app.post('/twiml/ftbend-answer', function(req, res) {
  var callId = req.query.callId;
  var officeId = req.query.officeId;
  var config = pendingCalls.get(callId);
  var twiml = new twilio.twiml.VoiceResponse();
  
  console.log('[FTBEND] Call answered for office: ' + officeId);
  twiml.pause({ length: 3 });
  twiml.pause({ length: 45 });
  twiml.hangup();
  
  res.type('text/xml').send(twiml.toString());
});

// /twiml/ftbend-result and /twiml/ftbend-fallback (Twilio <Gather> action URLs)
// were removed — Fort Bend office detection runs in /webhook/recording via
// the Deepgram path. Re-add them only if <Gather> is reintroduced.

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



// ========== FORT BEND CROSS-CHECK (verification layer) ==========
// Fetch finishprobation.com's published "today's color" for an office and
// cross-check it against what our own Deepgram-transcribed call produced.
// finishprobation publishes the same data via JSON embedded in their
// Next.js page (__NEXT_DATA__ script tag). We extract testGroups (array of
// color/phase strings) from the latest release.
//
// Slug mapping is hardcoded because finishprobation's URLs are inconsistent
// — 2 of 3 use the misspelled "ford" form, 1 uses the correct "fort". The
// "correct" spelling returns 500 for the misspelled-form offices. Verified
// 2026-05-20.
async function fetchFinishProbationGroundTruth(officeId) {
  var slugMap = {
    'missouri':   'tx-ford-bend-county-probation',   // misspelled in upstream
    'rosenberg':  'tx-ford-bend-county-pretrial',    // misspelled in upstream
    'rosenberg2': 'tx-fort-bend-county-drug-court'   // correctly spelled
  };
  var slug = slugMap[officeId];
  if (!slug) return { error: 'unknown_office:' + officeId };

  var url = 'https://finishprobation.com/test-locations/' + slug;
  var res;
  try {
    res = await fetch(url);
  } catch (e) {
    return { error: 'fetch_threw:' + e.message };
  }
  if (!res.ok) return { error: 'http_' + res.status };

  var html;
  try {
    html = await res.text();
  } catch (e) {
    return { error: 'body_read_failed:' + e.message };
  }

  var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (!match) return { error: 'no_next_data' };

  var data;
  try {
    data = JSON.parse(match[1]);
  } catch (e) {
    return { error: 'json_parse_failed:' + e.message };
  }

  var releases = (data && data.props && data.props.pageProps && data.props.pageProps.releases) || [];
  if (!releases.length) return { error: 'no_releases' };

  var latest = releases.reduce(function(a, b) {
    return (a.createdAt > b.createdAt) ? a : b;
  });

  // Freshness check — must be today in America/Chicago.
  var todayLocal = formatLocalDay(new Date(), 'America/Chicago');
  var latestLocal = formatLocalDay(new Date(latest.createdAt), 'America/Chicago');
  if (todayLocal !== latestLocal) {
    return { error: 'not_today', latest_date: latestLocal };
  }

  return {
    testGroups: latest.testGroups || [],
    createdAt: latest.createdAt,
    transcript: latest.phoneRecording || ''
  };
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

async function storeFtbendColor(color, transcript, officeId, phase1, phase2) {
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var today = cst.getFullYear() + '-' + String(cst.getMonth() + 1).padStart(2, '0') + '-' + String(cst.getDate()).padStart(2, '0');
  
  var office = FTBEND_OFFICES[officeId] || { name: officeId };
  console.log('[FTBEND] Storing ' + office.name + ' color: ' + color + ' for ' + today);
  
  try {
    var countyKey = 'ftbend_' + officeId;
    
    var existing = await supabase.from('daily_county_status')
      .select('*')
      .eq('county', countyKey)
      .eq('date', today)
      .single();
    
    var data = {
      county: countyKey,
      date: today,
      color: color,
      transcript: transcript,
      phase1_color: phase1,
      phase2_color: phase2,
      office_name: office.name
      
    };
    
    var result;
    if (existing.data) {
      result = await supabase.from('daily_county_status')
        .update(data)
        .eq('id', existing.data.id);
    } else {
      result = await supabase.from('daily_county_status').insert(data);
    }
    
    if (result.error) {
      console.error('[FTBEND] Database error:', result.error);
    } else {
      console.log('[FTBEND] Stored ' + office.name + ' color: ' + color);
    }
  } catch (e) {
    console.error('[FTBEND] Exception storing color:', e.message);
  }
}

async function notifyFtbendOfficeUsers(officeId, config) {
  var office = FTBEND_OFFICES[officeId] || { name: officeId };
  
  // Get users subscribed to this specific office
  var result = await supabase.from('user_schedules')
    .select('*')
    .eq('county', 'ftbend')
    .eq('ftbend_office', officeId)
    .eq('enabled', true);
  
  if (!result.data || result.data.length === 0) {
    console.log('[FTBEND] No users subscribed to ' + office.name);
    return;
  }
  
  console.log('[FTBEND] Notifying ' + result.data.length + ' users for ' + office.name);
  
  // Determine today's color(s)
  var todayColors = [];
  if (config.phase1) todayColors.push(config.phase1.toLowerCase());
  if (config.phase2) todayColors.push(config.phase2.toLowerCase());
  if (config.result && config.result !== 'UNKNOWN' && config.result !== 'PHASES' && todayColors.length === 0) {
    todayColors.push(config.result.toLowerCase());
  }
  var todayDisplay = todayColors.map(function(c) { return c.charAt(0).toUpperCase() + c.slice(1); }).join(' & ');
  var isUnknown = todayColors.length === 0;
  
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var currentHour = cst.getHours();
  var currentMin = cst.getMinutes();
  
  for (var i = 0; i < result.data.length; i++) {
    var sched = result.data[i];
    var schedHour = sched.hour !== undefined ? sched.hour : 5;
    var schedMin = sched.minute !== undefined ? sched.minute : 10;
    
    var delayMs = i * 2000;
    if (schedHour > currentHour || (schedHour === currentHour && schedMin > currentMin)) {
      var minutesUntil = (schedHour - currentHour) * 60 + (schedMin - currentMin);
      delayMs = minutesUntil * 60 * 1000 + (i * 1000);
    }
    
    (function(s, delay, msg, oid, cfg) {
      setTimeout(async function() {
        var profileResult = await supabase.from('profiles').select('credits, email').eq('id', s.user_id).single();
        var profile = profileResult.data;
        if (!profile) return;
        var isDevUser = isDev(profile.email);
        if (!isDevUser && profile.credits < 1) {
          var skipCount = (s.no_credit_skip_count || 0) + 1;
          console.log('[FTBEND] User ' + s.user_id.slice(0,8) + '... has no credits, skipping');
          if (skipCount >= 2) {
            await supabase.from('user_schedules').delete().eq('user_id', s.user_id);
            await notify(s.notify_number, s.notify_email, s.notify_method, '⚠️ Schedule Removed\n\nYour daily check-ins have stopped due to no credits remaining.\n\nPurchase credits and set up your schedule again at:\nprobationcall.com\n\n- ProbationCall.com', 'ftbend');
          } else {
            await supabase.from('user_schedules').update({ no_credit_skip_count: skipCount }).eq('user_id', s.user_id);
            await notify(s.notify_number, s.notify_email, s.notify_method, '⚠️ Call Skipped - Low Credits\n\nToday\'s check-in was skipped because you\'re out of credits. Your schedule will be removed tomorrow if credits are not added.\n\nPurchase credits now at:\nprobationcall.com\n\n- ProbationCall.com', 'ftbend');
          }
          await supabase.from('call_history').insert({ user_id: s.user_id, target_number: FTBEND_OFFICES[oid] ? FTBEND_OFFICES[oid].number : COUNTIES.ftbend.number, result: 'NO_CREDITS', county: 'ftbend', ftbend_office: oid });
          return;
        }
        // Get user's assigned color
        var userProfileResult = await supabase.from('profiles').select('user_color').eq('id', s.user_id).single();
        var userColor = (userProfileResult.data && userProfileResult.data.user_color) ? userProfileResult.data.user_color.toLowerCase() : null;
        
        var personalMsg;
        if (isUnknown) {
          personalMsg = '⚠️ Could not detect today\'s color.\n\nPlease call the hotline to verify:\n' + (FTBEND_OFFICES[oid] ? FTBEND_OFFICES[oid].number : '+12812383668') + '\n\n- ProbationCall.com';
        } else if (userColor && todayColors.indexOf(userColor) >= 0) {
          personalMsg = '🚨 TEST REQUIRED! 🚨\n\nToday\'s color is ' + todayDisplay + '.\n\nYour color (' + userColor.charAt(0).toUpperCase() + userColor.slice(1) + ') was called. You MUST test today.\n\n- ProbationCall.com';
        } else if (userColor) {
          personalMsg = '✅ No test today!\n\nToday\'s color is ' + todayDisplay + '.\nYour color (' + userColor.charAt(0).toUpperCase() + userColor.slice(1) + ') was NOT called. Enjoy your day!\n\n- ProbationCall.com';
        } else {
          personalMsg = '🎨 Today\'s Color: ' + todayDisplay + '\n\nFort Bend ' + office.name + '\n\nCheck if this is your assigned color.\n\n- ProbationCall.com';
        }

        // Cutoff path used finishprobation.com because our own call could
        // not confirm. Append a disclaimer line so users know to verify.
        if (cfg.verifiedViaFinishProbation) {
          personalMsg = personalMsg.replace(/\n\n- ProbationCall\.com$/, '\n\n(Verified via finishprobation.com — our call could not confirm today. Verify by phone if uncertain.)\n\n- ProbationCall.com');
        }

        console.log('[FTBEND] Sending ' + oid + ' notification to ' + s.user_id.slice(0,8) + ' (user color: ' + (userColor || 'none') + ', today: ' + todayDisplay + (cfg.verifiedViaFinishProbation ? ', verified=true' : '') + ')');
        await notify(s.notify_number, s.notify_email, s.notify_method, personalMsg, 'ftbend_daily');
        // Don't bill when we couldn't detect today's color (UNKNOWN).
        // Key includes user_id so per-user billing is independent.
        var todayDate = (new Date()).toISOString().slice(0, 10);
        var shouldMarkFtBilled = false;
        if (!isUnknown) {
          shouldMarkFtBilled = await deductCreditOnce(s.user_id, 'ftbend:' + s.user_id + ':' + oid + ':' + todayDate, {
            notifyNumber: s.notify_number,
            notifyEmail: s.notify_email,
            notifyMethod: s.notify_method,
            alreadyBilledCheck: async function() {
              var r = await supabase.from('call_history')
                .select('id')
                .eq('user_id', s.user_id)
                .eq('county', 'ftbend')
                .eq('ftbend_office', oid)
                .gte('created_at', todayDate + 'T00:00:00')
                .lte('created_at', todayDate + 'T23:59:59')
                .not('billed_at', 'is', null)
                .limit(1);
              if (r.error) throw r.error;
              return !!(r.data && r.data.length > 0);
            }
          });
        }
        var ftRow = {
          user_id: s.user_id,
          target_number: FTBEND_OFFICES[oid] ? FTBEND_OFFICES[oid].number : COUNTIES.ftbend.number,
          result: cfg.hasPhases ? 'P1:' + (cfg.phase1 || '?') + ' P2:' + (cfg.phase2 || '?') : 'COLOR:' + cfg.result,
          county: 'ftbend',
          ftbend_office: oid
        };
        if (shouldMarkFtBilled) ftRow.billed_at = new Date().toISOString();
        await supabase.from('call_history').insert(ftRow);
      }, delay);
    })(sched, delayMs, null, officeId, config);
  }
}

// Cutoff_no_ground_truth path: 9:30 AM CDT reached and finishprobation.com
// still has no data. Notify subscribed users of the final failure with the
// attempt count so they know we genuinely tried. Does NOT call
// storeFtbendColor (no answer to store) and does NOT bill any credit.
async function finalFailFortBendOffice(officeId, attemptCount, hotlineNumber) {
  var office = FTBEND_OFFICES[officeId] || { name: officeId, number: hotlineNumber };
  var result = await supabase.from('user_schedules')
    .select('*')
    .eq('county', 'ftbend')
    .eq('ftbend_office', officeId)
    .eq('enabled', true);
  if (!result.data || result.data.length === 0) {
    console.log('[FTBEND-RETRY] Final-fail: no users subscribed to ' + officeId);
    return;
  }
  var phoneForVerify = (office && office.number) || hotlineNumber || '';
  var msg = '⚠️ Could not determine today\'s color for Fort Bend ' + office.name
    + '\n\nWe tried ' + attemptCount + ' times this morning but could not get a clear result, '
    + 'and finishprobation.com hasn\'t published either. Please call the hotline yourself to verify: '
    + phoneForVerify
    + '\n\n- ProbationCall.com';
  for (var i = 0; i < result.data.length; i++) {
    (function(s, idx) {
      setTimeout(async function() {
        await notify(s.notify_number, s.notify_email, s.notify_method, msg, 'ftbend_final_fail').catch(function(e) {
          console.error('[FTBEND-RETRY] Final-fail notify error for ' + s.user_id.slice(0, 8) + ':', e.message);
        });
      }, idx * 1000);
    })(result.data[i], i);
  }
  console.log('[FTBEND-RETRY] Final-fail notifications dispatched for ' + officeId + ' to ' + result.data.length + ' users after ' + attemptCount + ' attempts');
}

// Cron job - 5:05 AM CST every day, calls all offices
cron.schedule('5 5 * * *', function() {
  console.log('[FTBEND] Cron triggered - starting daily color calls for all offices');
  ftbendDailyColorCall();
}, { timezone: 'America/Chicago' });

app.get("/api/ftbend/colors", auth, async function(req, res) {
  // Get colors from all Fort Bend offices
  var result = await supabase.from("daily_county_status")
    .select("*")
    .like("county", "ftbend%")
    .order("date", { ascending: false })
    .limit(270);
  
  res.json({ colors: result.data || [], offices: FTBEND_OFFICES });
});

app.get('/api/recording/:recordingSid', function(req, res) {
  var recordingSid = req.params.recordingSid;
  var https = require('https');
  
  var options = {
    hostname: 'api.twilio.com',
    path: '/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Recordings/' + recordingSid + '.mp3',
    auth: process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  };
  
  https.get(options, function(twilioRes) {
    if (twilioRes.statusCode !== 200) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    res.set('Content-Type', 'audio/mpeg');
    twilioRes.pipe(res);
  }).on('error', function(e) {
    console.error('[RECORDING] Proxy error:', e.message);
    res.status(500).json({ error: e.message });
  });
});

app.get("/api/ftbend/today", async function(req, res) {
  var now = new Date();
  var cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  var hour = cst.getHours();
  
  var dateToShow = new Date(cst);
  if (hour < 4) {
    dateToShow.setDate(dateToShow.getDate() - 1);
  }
  var dateStr = dateToShow.toISOString().split("T")[0];
  
  // Get all office colors for today
  var result = await supabase.from("daily_county_status")
    .select("*")
    .like("county", "ftbend%")
    .eq("date", dateStr);
  
  var offices = {};
  if (result.data) {
    result.data.forEach(function(r) {
      var officeId = r.county.replace("ftbend_", "");
      offices[officeId] = {
        color: r.color,
        phase1: r.phase1_color,
        phase2: r.phase2_color,
        office_name: r.office_name,
        recording_url: r.recording_url,
        transcript: r.transcript
      };
    });
  }
  
  res.json({ date: dateStr, offices: offices, officeConfig: FTBEND_OFFICES });
});


// ========== END FT BEND SYSTEM ==========


// Save probation end date
app.post('/api/profile/probation-end', auth, async function(req, res) {
  var endDate = req.body.endDate;
  if (!endDate) return res.status(400).json({ error: 'End date required' });
  
  await supabase.from('profiles').update({ 
    probation_end_date: endDate 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});

// Save user's assigned color (for Ft Bend)
app.post('/api/profile/color', auth, async function(req, res) {
  var color = req.body.color;
  if (!color) return res.status(400).json({ error: 'Color required' });
  
  await supabase.from('profiles').update({ 
    user_color: color.toLowerCase() 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});

// Tiered pricing for the "buy exact credits" flow — single source of truth
// used by /api/calculate-credits (estimate display) AND /api/checkout/custom
// (actual charge). Tiers: $0.50/credit for the first 30, $0.42 for 31-90,
// $0.33 for 91+. $5 minimum (Stripe-compatible floor).
//
// IMPORTANT: existing credit balance does NOT discount this — pricing is
// based purely on the number of credits being purchased. The dashboard
// calculator mirrors this same formula client-side for live UX feedback,
// but the server is authoritative and recomputes here on every checkout.
function computeTieredPriceCents(credits) {
  if (!Number.isFinite(credits) || credits < 1) return 0;
  var price;
  if (credits <= 30) {
    price = credits * 50;
  } else if (credits <= 90) {
    price = (30 * 50) + ((credits - 30) * 42);
  } else {
    price = (30 * 50) + (60 * 42) + ((credits - 90) * 33);
  }
  return Math.max(500, price);
}

// Reasonable cap on a single exact-credits purchase. About 5 years.
// Longer probation can buy multiple times; this bounds the server-side
// trust window for client-supplied credit amounts.
var MAX_EXACT_CREDITS = 1825;

// Calculate credits needed for remaining probation. Pricing uses the shared
// tiered model — no balance deduction (the customer pays the same regardless
// of any credits they already have on file).
app.get('/api/calculate-credits', auth, async function(req, res) {
  var endDate = req.query.endDate;
  if (!endDate) return res.status(400).json({ error: 'End date required' });

  var end = new Date(endDate);
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var daysRemaining = Math.ceil((end - today) / (1000 * 60 * 60 * 24));
  if (daysRemaining < 0) daysRemaining = 0;

  var creditsNeeded = daysRemaining;
  var totalCents = computeTieredPriceCents(creditsNeeded);

  res.json({
    daysRemaining: daysRemaining,
    creditsNeeded: creditsNeeded,
    priceCents: totalCents,
    priceDisplay: '$' + (totalCents / 100).toFixed(2)
  });
});

// === SUBSCRIPTION CHECKOUT ===
// Recurring $14.99/mo. Price ID lives in env so it's environment-specific.
// No affiliate code accepted on this path; affiliate commission is not
// calculated for subscription payments per current policy.
app.post('/api/subscription/checkout', auth, rateLimit('checkout', 10, 5 * 60 * 1000), async function(req, res) {
  try {
    var priceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
    if (!priceId) {
      console.error('[SUBSCRIPTION] STRIPE_SUBSCRIPTION_PRICE_ID env var not set');
      return res.status(500).json({ error: 'Subscription is not configured' });
    }
    if (req.profile.subscription_status === 'active' && req.profile.stripe_customer_id) {
      return res.status(400).json({ error: 'You already have an active subscription. Use Manage Subscription to make changes.' });
    }
    var params = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.BASE_URL + '/dashboard?subscribed=true',
      cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
      // user_id on the SUBSCRIPTION metadata so renewal invoices can resolve back to this user.
      subscription_data: { metadata: { user_id: req.user.id } },
      // user_id on the SESSION metadata so checkout.session.completed can write profile fields.
      metadata: { user_id: req.user.id, type: 'subscription' }
    };
    if (req.profile.stripe_customer_id) {
      params.customer = req.profile.stripe_customer_id;
    } else {
      params.customer_email = req.user.email;
    }
    var session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (e) {
    console.error('[SUBSCRIPTION] Checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// === SUBSCRIPTION CUSTOMER PORTAL (cancel / update payment method / view invoices) ===
// Requires the Customer Portal to be configured once in Stripe Dashboard:
// https://dashboard.stripe.com/settings/billing/portal
app.post('/api/subscription/portal', auth, async function(req, res) {
  try {
    if (!req.profile.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription on file' });
    }
    var portal = await stripe.billingPortal.sessions.create({
      customer: req.profile.stripe_customer_id,
      return_url: process.env.BASE_URL + '/dashboard'
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error('[SUBSCRIPTION] Portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Custom credits purchase for exact probation length.
// Server is authoritative on price: it RECOMPUTES priceCents from the
// credits value using the shared tiered model and IGNORES whatever
// priceCents the client posts. Trusting the client price was the original
// bug (anyone could curl {credits:1000, priceCents:500} and get 1000
// credits for $5). The dashboard's local calculator is a UX convenience
// only — it has no authority over what's actually charged.
app.post('/api/checkout/custom', auth, rateLimit('checkout', 10, 5 * 60 * 1000), async function(req, res) {
  var credits = parseInt(req.body.credits, 10);

  if (!Number.isInteger(credits) || credits < 1) {
    return res.status(400).json({ error: 'Invalid credits' });
  }
  if (credits > MAX_EXACT_CREDITS) {
    return res.status(400).json({ error: 'Maximum ' + MAX_EXACT_CREDITS + ' credits per purchase. Please buy in multiple smaller orders, or contact support for a longer term.' });
  }

  // Authoritative server-side price. Client-supplied req.body.priceCents is
  // intentionally not read.
  var priceCents = computeTieredPriceCents(credits);
  if (priceCents < 500) {
    // Defensive — shouldn't happen because the floor lives inside the helper,
    // but keep the guard so any future bug here can't create sub-Stripe-minimum sessions.
    return res.status(500).json({ error: 'price_compute_below_minimum' });
  }

  var session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'ProbationCall - ' + credits + ' Credits (Custom)' },
        unit_amount: priceCents
      },
      quantity: 1
    }],
    mode: 'payment',
    success_url: process.env.BASE_URL + '/dashboard?success=true',
    cancel_url: process.env.BASE_URL + '/dashboard?canceled=true',
    metadata: { user_id: req.user.id, package_id: 'custom', credits: String(credits) }
  });

  res.json({ url: session.url });
});

// Mark onboarding complete
app.post('/api/profile/onboarding-complete', auth, async function(req, res) {
  await supabase.from('profiles').update({ 
    onboarding_complete: true 
  }).eq('id', req.user.id);
  
  res.json({ success: true });
});


module.exports = app;

// ========== MISSED CALL RECOVERY ==========
// Runs every hour to catch any missed scheduled calls
cron.schedule('45 * * * *', async function() {
  console.log('[RECOVERY] Checking for missed calls...');
  
  var now = new Date();
  var cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var currentHour = cst.getHours();
  var currentMin = cst.getMinutes();
  var todayStart = new Date(cst);
  todayStart.setHours(0, 0, 0, 0);
  
  // Get all enabled schedules that should have run by now
  var schedResult = await supabase.from('user_schedules')
    .select('*')
    .eq('enabled', true)
    .neq('county', 'ftbend'); // Ft Bend handled separately
  
  if (!schedResult.data || schedResult.data.length === 0) return;
  
  for (var i = 0; i < schedResult.data.length; i++) {
    var sched = schedResult.data[i];
    var schedHour = sched.hour || 6;
    var schedMin = sched.minute || 0;
    
    // Calculate minutes since scheduled time
    var minutesSinceScheduled = (currentHour - schedHour) * 60 + (currentMin - schedMin);
    
    // Skip if scheduled time hasn't passed OR if within 20-min stagger window
    if (minutesSinceScheduled < 20) continue;
    
    // Check if call was made today
    var callResult = await supabase.from('call_history')
      .select('id')
      .eq('user_id', sched.user_id)
      .gte('created_at', todayStart.toISOString())
      .limit(1);

    if (callResult.data && callResult.data.length > 0) continue; // Already called today

    // Also skip if a retry sequence is in flight — no call_history row gets
    // written until the morning resolves, but pending_retries IS populated.
    // Without this check we'd collide with a queued retry.
    var pendingRetryResult = await supabase.from('pending_retries')
      .select('id')
      .eq('user_id', sched.user_id)
      .limit(1);
    if (pendingRetryResult.data && pendingRetryResult.data.length > 0) continue;

    console.log('[RECOVERY] MISSED CALL detected for user ' + sched.user_id.slice(0,8) + '... (scheduled ' + schedHour + ':' + String(schedMin).padStart(2,'0') + ')');
    
    // Get user profile and credits
    var profileResult = await supabase.from('profiles').select('credits, email').eq('id', sched.user_id).single();
    var profile = profileResult.data;
    if (!profile) continue;
    
    var isDevUser = isDev(profile.email);
    
    if (!isDevUser && profile.credits < 1) {
      console.log('[RECOVERY] User ' + sched.user_id.slice(0,8) + '... has no credits, skipping');
      await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ ProbationCall: Your scheduled call was missed and you have no credits!\n\nPlease purchase credits at probationcall.com\n\n- ProbationCall.com', 'recovery');
      await supabase.from('call_history').insert({ user_id: sched.user_id, target_number: sched.target_number, pin_used: sched.pin, result: 'NO_CREDITS' });
      continue;
    }
    
    // Make the recovery call. Credit is deducted in /webhook/recording.
    // isScheduledMorning=true so a no-result outcome enters the auto-retry
    // sequence — recovery is functionally a delayed scheduled-morning call.
    console.log('[RECOVERY] Initiating recovery call for ' + sched.user_id.slice(0,8) + '...');
    try {
      await initiateCall(sched.target_number, sched.pin, sched.notify_number, sched.notify_email, sched.notify_method, sched.user_id, 0, undefined, true);
    } catch (e) {
      console.error('[RECOVERY] Call failed for ' + sched.user_id.slice(0,8) + '...:', e.message);
      await notify(sched.notify_number, sched.notify_email, sched.notify_method, '⚠️ Call Issue\n\nWe had trouble completing your check-in today. Please call the hotline manually to verify.\n\n- ProbationCall.com', 'recovery');
    }
    
    // Small delay between recovery calls
    await new Promise(function(r) { setTimeout(r, 5000); });
  }
  
  console.log('[RECOVERY] Check complete');
}, { timezone: 'America/Chicago' });


// ========== AUTO-RETRY POLLER ==========
// Per-minute scan of pending_retries. Fires any due retry whose
// next_attempt_at <= now AND whose lease has expired. Restart-safe:
// pending_retries rows survive a container restart, and this poller
// resumes work on the next minute boundary after boot.
cron.schedule('* * * * *', async function() {
  var dueResult = await supabase.from('pending_retries')
    .select('*')
    .lte('next_attempt_at', new Date().toISOString());
  if (dueResult.error) {
    console.error('[RETRY-POLLER] Failed to scan pending_retries:', dueResult.error.message);
    return;
  }
  if (!dueResult.data || dueResult.data.length === 0) return;

  for (var i = 0; i < dueResult.data.length; i++) {
    var row = dueResult.data[i];
    var userId = row.user_id;

    // TZ lookup for cutoff check + day comparison. Fallback if the
    // schedule was deleted out from under us.
    var tz = await getUserTimezone(userId);

    // Orphan-cleanup guard: if a confirmed result for this user already
    // exists today (e.g. crash between webhook insert and pending_retries
    // delete), don't fire — just clean up the orphan row.
    var twentyFourAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    var confirmedQuery = await supabase.from('call_history')
      .select('id, result, created_at')
      .eq('user_id', userId)
      .gte('created_at', twentyFourAgo.toISOString())
      .in('result', ['MUST_TEST', 'NO_TEST', 'PIN_EXPIRED']);
    var todayLocal = formatLocalDay(new Date(), tz);
    var confirmedToday = false;
    if (confirmedQuery.data) {
      for (var j = 0; j < confirmedQuery.data.length; j++) {
        if (formatLocalDay(new Date(confirmedQuery.data[j].created_at), tz) === todayLocal) {
          confirmedToday = true;
          break;
        }
      }
    }
    if (confirmedToday) {
      console.log('[RETRY-POLLER] Orphan pending_retries row for ' + userId.slice(0, 8) + ' — morning already resolved by confirmed result. Deleting, not firing.');
      await supabase.from('pending_retries').delete().eq('id', row.id);
      continue;
    }

    // Cutoff check at fire time. If now is already past 14:00 local
    // (poller slipped, container restart delay, etc.), final-fail
    // instead of firing.
    if (wouldExceedCutoff(new Date(), tz)) {
      console.log('[RETRY-POLLER] Cutoff exceeded for ' + userId.slice(0, 8) + ' — final-fail instead of firing');
      await finalFailMorning({
        user_id: userId,
        county: row.county,
        target_number: row.target_number,
        pin: row.pin,
        notify_number: row.notify_number,
        notify_email: row.notify_email,
        notify_method: row.notify_method,
        attempt_number: row.attempt_number,
        last_result: row.last_result,
        last_call_sid: row.last_call_sid,
        last_transcript: row.last_transcript,
        last_recording_url: row.last_recording_url
      }, row);
      continue;
    }

    // Lease: bump next_attempt_at to +10 min so the next poller tick
    // doesn't double-fire while this call is in flight. The webhook
    // handler will update the row (or delete it) on resolution.
    var leaseUntil = new Date(Date.now() + 10 * 60 * 1000);
    var leaseUpd = await supabase.from('pending_retries')
      .update({ next_attempt_at: leaseUntil.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (leaseUpd.error) {
      console.error('[RETRY-POLLER] Failed to set lease for ' + userId.slice(0, 8) + ':', leaseUpd.error.message);
      continue;
    }

    console.log('[RETRY-POLLER] Firing retry attempt ' + (row.attempt_number + 1) + ' for ' + userId.slice(0, 8));
    try {
      await initiateCall(
        row.target_number,
        row.pin,
        row.notify_number,
        row.notify_email,
        row.notify_method,
        userId,
        row.attempt_number,
        row.county,
        true
      );
    } catch (e) {
      console.error('[RETRY-POLLER] Failed to fire retry for ' + userId.slice(0, 8) + ':', e.message);
      // Lease still expires in 10 min and the poller will try again.
    }
  }

  // ========== FORT BEND RETRY POLLER BRANCH ==========
  // Additive — doesn't touch the pending_retries loop above. Scans
  // fort_bend_retries for due rows. Per office: orphan-skip if a confirmed
  // answer already landed today, cutoff-handle if past 9:30 CDT, else
  // lease+fire. Same per-minute cadence as Montgomery.
  var ftbDueResult = await supabase.from('fort_bend_retries')
    .select('*')
    .lte('next_attempt_at', new Date().toISOString());
  if (ftbDueResult.error) {
    console.error('[FTBEND-RETRY-POLLER] Failed to scan fort_bend_retries:', ftbDueResult.error.message);
  } else if (ftbDueResult.data && ftbDueResult.data.length > 0) {
    for (var k = 0; k < ftbDueResult.data.length; k++) {
      var ftbRow = ftbDueResult.data[k];
      var ftbOfficeId = ftbRow.office;
      var ftbOffice = FTBEND_OFFICES[ftbOfficeId];
      if (!ftbOffice) {
        console.error('[FTBEND-RETRY-POLLER] Unknown office "' + ftbOfficeId + '" in retries row ' + ftbRow.id + ' — deleting');
        await supabase.from('fort_bend_retries').delete().eq('id', ftbRow.id);
        continue;
      }

      // Orphan skip — confirmed answer already logged today via another path?
      var ftbTodayLocal = formatLocalDay(new Date(), 'America/Chicago');
      var confirmedQuery = await supabase.from('fort_bend_learnings')
        .select('id')
        .eq('date', ftbTodayLocal)
        .eq('office', ftbOfficeId)
        .in('match_method', ['detection_already_correct', 'substring', 'phonetic'])
        .limit(1);
      if (confirmedQuery.data && confirmedQuery.data.length > 0) {
        console.log('[FTBEND-RETRY-POLLER] Orphan retry row for ' + ftbOfficeId + ' — confirmed answer already logged today. Deleting.');
        await supabase.from('fort_bend_retries').delete().eq('id', ftbRow.id);
        continue;
      }

      // Cutoff check at fire-time. If now is past 9:30 CDT, take cutoff path
      // (final fetch + notify-with-disclaimer OR final-fail) instead of
      // firing another Twilio call.
      if (wouldExceedFtbendCutoff(new Date(), 'America/Chicago')) {
        console.log('[FTBEND-RETRY-POLLER] Cutoff reached for ' + ftbOfficeId + ' — handling final outcome');
        var ftbHotline = ftbOffice.number || '';
        var ftbLastFetch = await fetchFinishProbationGroundTruth(ftbOfficeId).catch(function() { return null; });
        var ftbCutoffGT = (ftbLastFetch && ftbLastFetch.testGroups && ftbLastFetch.testGroups.length > 0) ? ftbLastFetch.testGroups : null;
        if (ftbCutoffGT) {
          var ftbJoined = ftbCutoffGT.join(', ');
          await storeFtbendColor(ftbJoined, ftbRow.last_transcript || '', ftbOfficeId, ftbCutoffGT[0], ftbCutoffGT[1] || null);
          await notifyFtbendOfficeUsers(ftbOfficeId, {
            result: ftbJoined,
            phase1: ftbCutoffGT[0],
            phase2: ftbCutoffGT[1] || null,
            hasPhases: !!(ftbOffice && ftbOffice.hasPhases),
            verifiedViaFinishProbation: true
          });
          await supabase.from('fort_bend_learnings').insert({
            date: ftbTodayLocal,
            office: ftbOfficeId,
            hotline_number: ftbHotline,
            raw_transcript: ftbRow.last_transcript,
            our_detection: ftbRow.last_our_detection,
            ground_truth: ftbJoined,
            match_method: 'cutoff_with_ground_truth',
            misrecognition_added: null,
            attempt_number: ftbRow.attempt_number
          }).then(function() {}, function(e) {
            console.error('[FTBEND-RETRY-POLLER] learnings insert failed:', e.message);
          });
          console.log('[FTBEND-RETRY-POLLER] Cutoff_with_ground_truth for ' + ftbOfficeId + ' (' + ftbJoined + ') after ' + ftbRow.attempt_number + ' attempts');
        } else {
          await finalFailFortBendOffice(ftbOfficeId, ftbRow.attempt_number, ftbHotline);
          await supabase.from('fort_bend_learnings').insert({
            date: ftbTodayLocal,
            office: ftbOfficeId,
            hotline_number: ftbHotline,
            raw_transcript: ftbRow.last_transcript,
            our_detection: ftbRow.last_our_detection,
            ground_truth: ftbRow.last_ground_truth,
            match_method: 'cutoff_no_ground_truth',
            misrecognition_added: null,
            attempt_number: ftbRow.attempt_number
          }).then(function() {}, function(e) {
            console.error('[FTBEND-RETRY-POLLER] learnings insert failed:', e.message);
          });
          console.log('[FTBEND-RETRY-POLLER] Cutoff_no_ground_truth for ' + ftbOfficeId + ' after ' + ftbRow.attempt_number + ' attempts');
        }
        await supabase.from('fort_bend_retries').delete().eq('id', ftbRow.id);
        continue;
      }

      // Lease — bump next_attempt_at to +10 min so the next poll tick
      // doesn't double-fire while the call is in flight. Webhook handler
      // will update or delete the row on resolution.
      var ftbLeaseUntil = new Date(Date.now() + 10 * 60 * 1000);
      var ftbLeaseUpd = await supabase.from('fort_bend_retries')
        .update({ next_attempt_at: ftbLeaseUntil.toISOString(), updated_at: new Date().toISOString() })
        .eq('id', ftbRow.id);
      if (ftbLeaseUpd.error) {
        console.error('[FTBEND-RETRY-POLLER] Lease set failed for ' + ftbOfficeId + ':', ftbLeaseUpd.error.message);
        continue;
      }

      console.log('[FTBEND-RETRY-POLLER] Firing retry for ' + ftbOfficeId + ' (attempt ' + (ftbRow.attempt_number + 1) + ')');
      try {
        await ftbendCallOffice(ftbOfficeId, ftbOffice);
      } catch (e) {
        console.error('[FTBEND-RETRY-POLLER] Failed to fire for ' + ftbOfficeId + ':', e.message);
        // Lease expires in 10 min and the poller will try again.
      }
    }
  }
}, { timezone: 'America/Chicago' });


// SAFETY FALLBACK
