// v1 bearer resolution and the account-deletion tombstone hash.
//
// resolveBearerUser asks the AUTH SERVER who a token belongs to. It never
// decodes the JWT locally. That distinction is what makes DELETE /account
// safe: a locally-decoded token stays "valid" until its exp (up to an hour)
// after the user is deleted, and the first /me in that hour would bootstrap
// a fresh profile with starter credits. Asking the server means a deleted
// user is rejected on the very next request. test/auth.test.js pins this.
var crypto = require('crypto');

async function resolveBearerUser(authClient, authHeader) {
  var token = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '') : '';
  if (!token) return { user: null, reason: 'missing' };
  var result = await authClient.auth.getUser(token);
  if (!result || result.error || !result.data || !result.data.user) return { user: null, reason: 'rejected' };
  return { user: result.data.user, reason: null };
}

// Hash of the normalised email, stored when an account is deleted so a
// re-signup with the same address does not collect starter credits again.
// A hash, not the address: the point of deletion is that we no longer hold
// the person's email.
function emailTombstoneHash(email) {
  var norm = String(email || '').trim().toLowerCase();
  if (!norm) return null;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = { resolveBearerUser: resolveBearerUser, emailTombstoneHash: emailTombstoneHash };
