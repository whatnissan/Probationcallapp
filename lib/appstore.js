// App Store In-App Purchase (build 23). The pure rules — which product grants
// what, how Apple's states map onto ours, what a refund takes back, what an
// affiliate earns — plus a thin wrapper around Apple's official verifier.
// test/appstore.test.js pins every rule; server.js does the I/O.
//
// Dave's rulings (2026-10-15):
//   - Products: the subscription (31 credits a month) and ONE credit pack of
//     30 (2026-10-16). Both match the website exactly: Stripe's subscription
//     grants SUBSCRIPTION_CREDITS_PER_PAYMENT (31) every payment, and its
//     one-time month pass grants 30. Larger amounts (90, 182, any number) are
//     website-only, through Stripe. The server owns product -> credits and
//     serves it from GET /pricing, so the app never hard-codes it.
//   - Refunds take credits back, stopping at zero, and flag the account.
//     REFUND_REVERSED gives them back.
//   - Sandbox purchases grant only to the demo and internal accounts, and
//     never count as revenue or commission. Any other Sandbox purchase is
//     recorded and grants nothing.
//   - Commission on an App Store purchase is 20% of NET, after Apple's cut.
//     Stripe stays on gross.

// The product ids to create in App Store Connect, exactly as written here.
// A product id cannot be renamed once created; if App Store Connect ends up
// with different ids, change them HERE, before the build ships.
var SUBSCRIPTION_PRODUCT_ID = 'com.probationcall.app.subscription.monthly';
// One pack in the App Store (Dave, 2026-10-16): 30 credits, the App Store
// twin of the website's one-time month pass (POST /api/checkout/month, 30
// credits). Larger amounts are bought on the website, where Stripe sells any
// number of credits. A product id not listed here is never granted: a .31,
// .90 or .182 purchase would answer iap_unknown_product and alert Dave.
var CREDIT_PACKS = [30];

function productCatalogue(subscriptionCredits) {
  return [{ productId: SUBSCRIPTION_PRODUCT_ID, kind: 'subscription', credits: subscriptionCredits }]
    .concat(CREDIT_PACKS.map(function(n) {
      return { productId: 'com.probationcall.app.credits.' + n, kind: 'credits', credits: n };
    }));
}

function productFor(catalogue, productId) {
  for (var i = 0; i < catalogue.length; i++) {
    if (catalogue[i].productId === productId) return catalogue[i];
  }
  return null;
}

// Apple's cut, in percent. 15% is the Small Business Program rate (and the
// rate on a subscription after its first year). If the account is not in the
// program, Apple takes 30% in a subscription's first year and on consumables,
// and this number is what changes.
var APPLE_COMMISSION_PERCENT = 15;

// Revenue in USD cents, or null. Null for anything that is not a Production
// purchase in US dollars: a Sandbox grant is not revenue, and a foreign price
// is not cents of a dollar.
function usdCents(tx) {
  if (!tx || tx.environment !== 'Production') return null;
  if (String(tx.currency || '').toUpperCase() !== 'USD') return null;
  if (typeof tx.price !== 'number' || !(tx.price >= 0)) return null;
  return Math.round(tx.price / 10);
}

// The affiliate's share of an App Store purchase: `ratePercent` of what is
// left after Apple's commission. Integer cents, rounded down. Zero when there
// is no USD revenue (usdCents is null).
function netCommissionCents(tx, ratePercent, applePercent) {
  var gross = usdCents(tx);
  if (gross === null) return 0;
  var apple = applePercent === undefined ? APPLE_COMMISSION_PERCENT : applePercent;
  return Math.floor(gross * (100 - apple) * ratePercent / 10000);
}

// Credits a refund takes back. A full refund (or a Family Sharing
// revocation) takes the purchase's credits; a prorated refund takes the
// refunded share, rounded down — the person keeps any fraction. The caller
// caps it at the balance: never below zero.
function refundCredits(creditsPurchased, revocationType, revocationPercentage) {
  var n = Math.max(0, Math.floor(Number(creditsPurchased) || 0));
  if (revocationType === 'REFUND_PRORATED') {
    var pct = Number(revocationPercentage);
    if (!(pct >= 0)) return n;
    return Math.min(n, Math.floor(n * pct / 100000));
  }
  return n;
}

// A full refund reverses the affiliate's commission; a partial one does not —
// the Stripe policy (handleChargeRefunded): only a full refund claws back.
function isFullRefund(revocationType) {
  return revocationType !== 'REFUND_PRORATED';
}

// Our subscription status from Apple's. Notifications carry Apple's own
// `status` (1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked),
// which is the authority whenever present. Without it (the app's POST),
// derive from the transaction: revoked or past expiry is canceled, otherwise
// active. Values are §3's: 'active' | 'past_due' | 'canceled'.
function subscriptionStatus(appleStatus, tx, nowMs) {
  switch (Number(appleStatus)) {
    case 1: return 'active';
    case 3: case 4: return 'past_due';
    case 2: case 5: return 'canceled';
  }
  if (!tx) return null;
  if (tx.revocationDate) return 'canceled';
  if (typeof tx.expiresDate === 'number' && tx.expiresDate <= (nowMs === undefined ? Date.now() : nowMs)) return 'canceled';
  return 'active';
}

// What a notification means for the subscription row, beyond the grant.
// `renewal` is the decoded signedRenewalInfo, when Apple sent one.
function subscriptionPatch(notificationType, appleStatus, tx, renewal, nowMs) {
  var patch = {};
  var status = subscriptionStatus(appleStatus, null, nowMs);
  if (!status) {
    if (notificationType === 'DID_FAIL_TO_RENEW' || notificationType === 'GRACE_PERIOD_EXPIRED') status = 'past_due';
    else if (notificationType === 'EXPIRED' || notificationType === 'REVOKE') status = 'canceled';
    else if (notificationType === 'SUBSCRIBED' || notificationType === 'DID_RENEW') status = 'active';
    else if (tx) status = subscriptionStatus(null, tx, nowMs);
  }
  if (status) patch.status = status;
  if (renewal && (renewal.autoRenewStatus === 0 || renewal.autoRenewStatus === 1)) patch.auto_renew = renewal.autoRenewStatus === 1;
  if (tx && typeof tx.expiresDate === 'number') patch.expires_at = new Date(tx.expiresDate).toISOString();
  if (tx && tx.transactionId) patch.last_transaction_id = String(tx.transactionId);
  return patch;
}

// The App Store environment a JWS claims, read WITHOUT verifying it, only to
// choose which verifier checks it — each verifier refuses any other
// environment, so a false claim fails verification rather than slipping by.
function claimedEnvironment(jws, isNotification) {
  try {
    var part = String(jws).split('.')[1];
    var body = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return isNotification ? (body.data && body.data.environment) || null : body.environment || null;
  } catch (e) {
    return null;
  }
}

// The .p8 key from App Store Connect, however it was pasted into Railway
// (literal \n, one long line, headers or not) — the same normalisation
// lib/apns.js does for the push key. Null when unset.
function normalisePem(raw) {
  var body = String(raw || '').replace(/\\n/g, '\n').replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
  if (!body) return null;
  return '-----BEGIN PRIVATE KEY-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
}

function AppStoreError(code, message, retryable) {
  var e = new Error(message);
  e.appStoreCode = code;            // 'not_configured' | 'invalid' | 'retryable'
  e.retryable = !!retryable;
  return e;
}

// Apple's verifier and API client, for Production and Sandbox. `opts`:
//   bundleId, appAppleId (needed for Production), rootCertificates (Buffer[]),
//   issuerId, keyId, privateKey (optional: the API cross-check),
//   onlineChecks (default true), library (tests inject a fake).
function createAppStore(opts) {
  var L = opts.library || require('@apple/app-store-server-library');
  var verifiers = {}, clients = {};
  var ENVS = { Production: L.Environment.PRODUCTION, Sandbox: L.Environment.SANDBOX };

  function verifierFor(env) {
    if (!ENVS[env]) throw AppStoreError('invalid', 'Unsupported App Store environment: ' + env, false);
    if (env === 'Production' && !opts.appAppleId) throw AppStoreError('not_configured', 'APPSTORE_APP_APPLE_ID is not set', true);
    if (!opts.rootCertificates || !opts.rootCertificates.length) throw AppStoreError('not_configured', 'Apple root certificates are missing', true);
    if (!verifiers[env]) {
      verifiers[env] = new L.SignedDataVerifier(opts.rootCertificates, opts.onlineChecks !== false, ENVS[env],
        opts.bundleId, env === 'Production' ? Number(opts.appAppleId) : undefined);
    }
    return verifiers[env];
  }

  // envHint: the environment of the notification a transaction or renewal
  // arrived in, used when the inner payload does not name its own. The
  // verifier still enforces it, so a wrong hint fails rather than passes.
  async function verify(kind, jws, envHint) {
    if (typeof jws !== 'string' || jws.split('.').length !== 3) throw AppStoreError('invalid', 'Not a signed App Store payload', false);
    var env = claimedEnvironment(jws, kind === 'notification') || envHint || null;
    var v = verifierFor(env);
    try {
      if (kind === 'notification') return await v.verifyAndDecodeNotification(jws);
      if (kind === 'renewal') return await v.verifyAndDecodeRenewalInfo(jws);
      return await v.verifyAndDecodeTransaction(jws);
    } catch (e) {
      var retry = e && e.status === L.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;
      throw AppStoreError(retry ? 'retryable' : 'invalid', 'App Store verification failed (' + (e && e.status !== undefined ? e.status : e.message) + ')', retry);
    }
  }

  function apiConfigured() { return !!(opts.issuerId && opts.keyId && opts.privateKey); }

  // Apple's current copy of a transaction — fresher than what the app posted
  // (it shows a revocation that happened since). Null when the API is not
  // configured; throws when Apple could not be asked, and the caller falls
  // back to the posted, already-verified copy.
  async function fetchTransaction(transactionId, env) {
    if (!apiConfigured()) return null;
    if (!clients[env]) clients[env] = new L.AppStoreServerAPIClient(opts.privateKey, opts.keyId, opts.issuerId, opts.bundleId, ENVS[env]);
    var r = await clients[env].getTransactionInfo(String(transactionId));
    if (!r || !r.signedTransactionInfo) return null;
    return verify('transaction', r.signedTransactionInfo);
  }

  return {
    verifyTransaction: function(jws, envHint) { return verify('transaction', jws, envHint); },
    verifyRenewal: function(jws, envHint) { return verify('renewal', jws, envHint); },
    verifyNotification: function(jws) { return verify('notification', jws); },
    fetchTransaction: fetchTransaction,
    apiConfigured: apiConfigured
  };
}

module.exports = {
  SUBSCRIPTION_PRODUCT_ID: SUBSCRIPTION_PRODUCT_ID,
  CREDIT_PACKS: CREDIT_PACKS,
  APPLE_COMMISSION_PERCENT: APPLE_COMMISSION_PERCENT,
  productCatalogue: productCatalogue,
  productFor: productFor,
  usdCents: usdCents,
  netCommissionCents: netCommissionCents,
  refundCredits: refundCredits,
  isFullRefund: isFullRefund,
  subscriptionStatus: subscriptionStatus,
  subscriptionPatch: subscriptionPatch,
  claimedEnvironment: claimedEnvironment,
  normalisePem: normalisePem,
  createAppStore: createAppStore,
  AppStoreError: AppStoreError
};
