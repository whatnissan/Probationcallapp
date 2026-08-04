// Input validation for user-writable fields that reach storage and, from
// there, the admin panel's innerHTML.
//
// Context: /api/schedule accepted req.body.pin and req.body.timezone with no
// validation at all, and /api/affiliate/payout-email accepted any string as
// an email. Those values were rendered raw in admin.html, which made stored
// XSS reachable by any authenticated user (fixed on the rendering side in
// 421ea53). Escaping is the security boundary; this module is the second
// layer, and it also keeps garbage out of the scheduler's timezone math.
//
// Pure functions, no I/O — unit-tested in test/validation.test.js.

// Montgomery/Fort Bend hotlines both take a 6-digit ID. All 9 live schedules
// are 6 digits, so this rejects nothing that currently works.
function isValidPin(pin) {
  return typeof pin === 'string' && /^[0-9]{6}$/.test(pin);
}

// Explicit IANA whitelist rather than "anything Intl accepts". The scheduler
// does cutoff math against this value, so an exotic-but-real zone would be
// accepted and then silently shift someone's morning call. Every live
// schedule is America/Chicago; the rest of the US is allowed because a
// subscriber can travel or move without their county changing.
var ALLOWED_TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Boise',
  'America/Juneau',
  'Pacific/Honolulu'
];

function isValidTimezone(tz) {
  return typeof tz === 'string' && ALLOWED_TIMEZONES.indexOf(tz) >= 0;
}

// Deliberately not RFC 5322. A pragmatic shape check plus a length cap:
// enough to keep control characters, angle brackets, and quotes out of a
// field that gets rendered and also handed to Brevo.
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  if (/[\s<>"'`\\]/.test(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email);
}

// Normalize to +1XXXXXXXXXX (US/Canada) or return null. Mirrors the accepting
// behavior of the existing formatPhone for 10- and 11-digit input, but unlike
// formatPhone it returns null instead of passing malformed input through.
function normalizePhoneE164(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  var raw = String(phone).trim();
  if (!raw) return null;
  var digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length !== 11 || digits[0] !== '1') return null;
  return '+' + digits;
}

// Support-message bounds. Generous enough for a real problem description,
// tight enough that a paste-bomb cannot fill the table or the admin panel.
function isValidSupportSubject(v) {
  if (typeof v !== 'string') return false;
  var t = v.trim();
  return t.length >= 3 && t.length <= 120;
}
function isValidSupportBody(v) {
  if (typeof v !== 'string') return false;
  var t = v.trim();
  return t.length >= 10 && t.length <= 4000;
}

module.exports = {
  isValidSupportSubject: isValidSupportSubject,
  isValidSupportBody: isValidSupportBody,
  isValidPin: isValidPin,
  isValidTimezone: isValidTimezone,
  isValidEmail: isValidEmail,
  normalizePhoneE164: normalizePhoneE164,
  ALLOWED_TIMEZONES: ALLOWED_TIMEZONES
};
