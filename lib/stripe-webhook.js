// Stripe webhook verification against MORE THAN ONE signing secret.
//
// Stripe has two kinds of endpoint: one that receives your own account's
// events, and one that receives events from CONNECTED accounts (account.updated
// for an affiliate's Express account arrives only on the second kind). Each
// endpoint has its own signing secret, and both can point at the same URL —
// so the handler must be willing to verify against either. Secrets that are
// unset are skipped; the first one that verifies wins; none = rejected.
function constructEventWithSecrets(stripe, rawBody, signature, secrets) {
  var list = (secrets || []).filter(Boolean);
  if (!list.length) throw new Error('no webhook signing secret configured');
  var lastErr = null;
  for (var i = 0; i < list.length; i++) {
    try { return stripe.webhooks.constructEvent(rawBody, signature, list[i]); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
module.exports = { constructEventWithSecrets: constructEventWithSecrets };
