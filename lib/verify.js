// Phone verification (§4.17): the pure parts, so the limits and the code
// check can be tested without Twilio or a database.
//
// Threat model, in order of cost to us: SMS pumping (someone triggering
// codes to numbers that pay them per message) — killed upstream by the +1
// only normaliser and bounded here by per-account, per-phone and global
// daily caps; brute force — five attempts per code, ten-minute expiry;
// harassment of a number — the per-phone cap counts across ALL accounts.
var crypto = require('crypto');

var LIMITS = {
  codeLength: 6,
  expiryMinutes: 10,
  maxAttempts: 5,
  resendSeconds: 60,
  perAccountPer10Min: 3,
  perAccountPerDay: 6,
  perPhonePer10Min: 3,
  perPhonePerDay: 6,
  globalPerDay: 100,
  globalAlertAt: 50
};

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(LIMITS.codeLength, '0');
}

// HMAC over user + phone + code: the same code for a different user or
// number is a different hash, so rows are not interchangeable.
function codeHmac(secret, userId, phone, code) {
  return crypto.createHmac('sha256', String(secret)).update(String(userId) + '|' + String(phone) + '|' + String(code)).digest('hex');
}

function safeEqual(a, b) {
  var x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function phoneLast4(phone) { return String(phone || '').slice(-4); }

// May we send? `sends` are timestamps (ms) of prior sends: for this account,
// for this phone (all accounts), and globally today; lastSameMs is the most
// recent send to this exact user+phone. Returns {ok} or {ok:false, reason,
// retryAfterSeconds}.
function decideSend(nowMs, sends) {
  var tenMin = nowMs - 10 * 60000, day = nowMs - 24 * 3600000;
  var within = function(list, since) { return (list || []).filter(function(t) { return t > since; }).length; };
  if (sends.lastSameMs && (nowMs - sends.lastSameMs) < LIMITS.resendSeconds * 1000) {
    return { ok: false, reason: 'resend_too_soon', retryAfterSeconds: Math.ceil((LIMITS.resendSeconds * 1000 - (nowMs - sends.lastSameMs)) / 1000) };
  }
  if (within(sends.account, tenMin) >= LIMITS.perAccountPer10Min || within(sends.phone, tenMin) >= LIMITS.perPhonePer10Min) {
    return { ok: false, reason: 'too_many_sends', retryAfterSeconds: 600 };
  }
  if (within(sends.account, day) >= LIMITS.perAccountPerDay || within(sends.phone, day) >= LIMITS.perPhonePerDay) {
    return { ok: false, reason: 'daily_limit', retryAfterSeconds: 24 * 3600 };
  }
  if (within(sends.global, day) >= LIMITS.globalPerDay) {
    return { ok: false, reason: 'service_limit', retryAfterSeconds: 3600 };
  }
  return { ok: true, alert: within(sends.global, day) + 1 >= LIMITS.globalAlertAt };
}

// Evaluate a code against the open row. Never reveals anything about the
// stored hash beyond match / no match.
function checkCode(row, nowMs, providedHmac) {
  if (!row) return { status: 'not_found' };
  if (row.consumed_at || row.superseded_at) return { status: 'not_found' };
  if (Date.parse(row.expires_at) <= nowMs) return { status: 'expired' };
  if ((row.attempts || 0) >= LIMITS.maxAttempts) return { status: 'locked' };
  if (safeEqual(row.code_hmac, providedHmac)) return { status: 'ok' };
  return { status: 'mismatch', attemptsRemaining: LIMITS.maxAttempts - (row.attempts || 0) - 1 };
}

module.exports = { LIMITS: LIMITS, generateCode: generateCode, codeHmac: codeHmac, phoneLast4: phoneLast4, decideSend: decideSend, checkCode: checkCode };
