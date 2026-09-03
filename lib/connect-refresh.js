// §4.14 — the capability behind GET /connect/refresh.
//
// Stripe sends a user to refresh_url when an Account Link has expired, was
// already visited, or was scanned from another device. The documented
// contract is that refresh_url calls back to the SERVER, mints a NEW Account
// Link with the same parameters, and redirects the browser to it. Ours
// pointed at the app-return page, so a link expiring mid-onboarding — and
// they expire in minutes, while onboarding takes several — dead-ended the
// affiliate with no way forward.
//
// The browser arriving there carries NO SESSION: it is Stripe's hosted flow,
// not our app. So the URL itself has to say which account to refresh.
//
// WHY ENCRYPTED AND NOT SIGNED. A signed token (the shape used by wsTicket
// elsewhere in this codebase) carries the id in the clear and only proves it
// was not tampered with. This URL is handed to Stripe, lands in browser
// history, and may appear in a Referer header, so the id must not be
// readable in it. AES-256-GCM gives all three properties at once:
// unguessable, unforgeable (the auth tag), and opaque.
//
// STATELESS ON PURPOSE: no table, no in-memory map. A server restart during
// onboarding must not strand anyone — that is the same class of dead end
// being fixed here.
//
// SCOPE OF THE CAPABILITY, and why the TTL is short. Anyone holding a live
// token can open onboarding for that Express account, which means they could
// submit THEIR bank details for it. That is the same risk Stripe's own
// Account Links carry, and Stripe mitigates it the same way — a short life.
// 30 minutes covers "the user got distracted mid-signup"; past that they tap
// Set up payouts in the app again and get a fresh link.
var crypto = require('crypto');

var TTL_MS = 30 * 60 * 1000;
var VERSION = 'v1';

// Domain-separated key derivation: the same secret used for another purpose
// yields a different key here, so a token from one context can never verify
// in the other.
function keyFrom(secret) {
  return crypto.createHash('sha256').update('connect-refresh|' + VERSION + '|' + String(secret)).digest();
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Returns null when no secret is configured, so the caller can fall back
// rather than throw. iv(12) | tag(16) | ciphertext.
function mintToken(userId, secret, nowMs, ttlMs) {
  if (!secret || !userId) return null;
  var payload = JSON.stringify({ u: String(userId), e: (nowMs || Date.now()) + (ttlMs || TTL_MS) });
  var iv = crypto.randomBytes(12);
  var c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  var ct = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  return b64url(Buffer.concat([iv, c.getAuthTag(), ct]));
}

// Returns the user id, or null for anything wrong: no secret, malformed,
// tampered, or expired. Never throws — this is driven by a URL a stranger
// can type.
function readToken(token, secret, nowMs) {
  if (!secret || !token) return null;
  try {
    var raw = unb64url(token);
    if (raw.length < 29) return null;
    var d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    var out = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!out || !out.u || !out.e) return null;
    if ((nowMs || Date.now()) > out.e) return null;
    return String(out.u);
  } catch (e) {
    return null;
  }
}

module.exports = { mintToken: mintToken, readToken: readToken, TTL_MS: TTL_MS };
