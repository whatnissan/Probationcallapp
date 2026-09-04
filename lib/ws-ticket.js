// Short-lived WebSocket tickets. A socket URL is logged in exactly the same
// places an HTTP URL is, so the session JWT must never appear in one; a
// ticket is a 60-second, single-purpose credential bound to one user id.
//
// Extracted from server.js so the verification can be tested directly.
// It is the only thing standing between a stranger and a WebSocket, and
// since it now reports WHY a ticket failed, the paths through it are worth
// pinning: "expired" and "forged" mean very different things operationally
// and must not be able to drift into each other.
var crypto = require('crypto');

function mint(secret, userId, expMs) {
  if (!secret) return null;
  var sig = crypto.createHmac('sha256', secret).update('ws.' + userId + '.' + expMs).digest('hex');
  return userId + '.' + expMs + '.' + sig;
}

// { userId, reason } — reason is for the SERVER LOG only. The client is
// told nothing but 401: "expired" and "forged" are different facts to us
// and the same answer to them.
//
// An expired ticket means a slow or looping client, and is our bug to fix.
// A bad signature means someone is making tickets up. Tonight (2026-09-03)
// those were indistinguishable in the logs, which is why identifying a
// client took hours instead of seconds.
function verify(secret, ticket, nowMs) {
  if (!secret) return { userId: null, reason: 'no_secret' };
  if (!ticket) return { userId: null, reason: 'no_ticket' };
  var parts = String(ticket).split('.');
  if (parts.length !== 3) return { userId: null, reason: 'malformed' };
  var userId = parts[0];
  var expMs = parseInt(parts[1], 10);
  if (!expMs || !userId) return { userId: null, reason: 'malformed' };
  var now = nowMs === undefined ? Date.now() : nowMs;
  // Expiry BEFORE the signature check, deliberately: an expired ticket is a
  // client problem and a forged one is not, and checking expiry first means
  // an expired-but-validly-signed ticket is never reported as a forgery.
  if (now > expMs) return { userId: null, reason: 'expired' };
  var expect = crypto.createHmac('sha256', secret).update('ws.' + userId + '.' + expMs).digest('hex');
  var a = Buffer.from(String(parts[2] || ''), 'utf8');
  var b = Buffer.from(expect, 'utf8');
  // Length first: timingSafeEqual THROWS on a length mismatch. Still
  // constant time against a same-length forgery, which is the case that
  // matters — a wrong-length one carries no information about the secret.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { userId: null, reason: 'bad_signature' };
  }
  return { userId: userId, reason: 'ok' };
}

module.exports = { mint: mint, verify: verify };
