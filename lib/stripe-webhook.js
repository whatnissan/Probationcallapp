// Stripe webhook verification against MORE THAN ONE signing secret.
//
// Stripe has two kinds of endpoint: one that receives your own account's
// events, and one that receives events from CONNECTED accounts (account.updated
// for an affiliate's Express account arrives only on the second kind). Each
// endpoint has its own signing secret.
//
// Since 2026-09-03 each of those endpoints has its own ROUTE and passes a
// single secret here, so no event is accepted under the wrong endpoint's
// secret. The list form is kept for the two properties it still buys: an
// unset/empty secret is skipped rather than handed to Stripe as undefined,
// and an empty list fails loudly instead of accepting anything. It also
// leaves room for a zero-downtime secret rotation, where both the old and
// new secret are briefly valid for the same endpoint.
//
// The first secret that verifies wins; none = rejected.
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
