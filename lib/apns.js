// APNs HTTP/2 client. No new dependency: node's built-in http2 plus the
// jsonwebtoken already here for Sign in with Apple.
//
// The signing key is the SAME .p8 as Sign in with Apple (key 42J4U7A8NA).
// Apple allows one key to carry both capabilities, and creating a second one
// is how teams end up unable to tell which key a revocation just broke.
//
// Provider tokens are cached and reused. Apple rate-limits token generation
// and rejects tokens minted more than once every 20 minutes with TooManyProviderTokenUpdates,
// while accepting a token for an hour — so we refresh at 45 minutes.

var http2 = require('http2');
var jwt = require('jsonwebtoken');

var HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
};
var TOKEN_TTL_MS = 45 * 60 * 1000;
// Apple normally answers in well under a second. These are deliberately tight
// because every second here is spent inside the 5 AM notify loop, per user:
// if APNs is down, we want to give up and text quickly, not hold the morning.
var REQUEST_TIMEOUT_MS = 5000;
// Ceiling for the entire send, connect included.
var OVERALL_TIMEOUT_MS = 6000;

var _token = null;
var _tokenMintedAt = 0;

function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID &&
            process.env.APNS_BUNDLE_ID && process.env.APNS_PRIVATE_KEY);
}

// Normalise whatever shape the key arrives in. Pasting a .p8 into an env var
// goes wrong in three predictable ways, and all three fail with the same
// unhelpful "secretOrPrivateKey must be an asymmetric key" at 5 AM:
//   - the BEGIN/END armour lines get dropped (only the base64 body pasted)
//   - newlines arrive escaped as \n rather than real breaks
//   - the body arrives as one long unwrapped line
// Strip back to the base64 body and rebuild the PEM ourselves. Deterministic,
// and it means a mis-paste degrades to "works" instead of "silent no-push".
function privateKey() {
  var raw = String(process.env.APNS_PRIVATE_KEY || '');
  if (!raw) return '';
  var body = raw.replace(/\\n/g, '\n').replace(/-----[^-]*-----/g, '').replace(/\s+/g, '');
  if (!body) return '';
  var wrapped = body.match(/.{1,64}/g).join('\n');
  return '-----BEGIN PRIVATE KEY-----\n' + wrapped + '\n-----END PRIVATE KEY-----\n';
}

function providerToken() {
  var now = Date.now();
  if (_token && (now - _tokenMintedAt) < TOKEN_TTL_MS) return _token;
  _token = jwt.sign({}, privateKey(), {
    algorithm: 'ES256',
    issuer: process.env.APNS_TEAM_ID,
    header: { alg: 'ES256', kid: process.env.APNS_KEY_ID },
    expiresIn: '55m'
  });
  _tokenMintedAt = now;
  return _token;
}

// Reset the cached token — called when Apple says it is stale so the next
// send mints a fresh one instead of failing identically forever.
function resetProviderToken() {
  _token = null;
  _tokenMintedAt = 0;
}

/**
 * Send one notification.
 *
 * Resolves to { ok, status, apnsId, reason, unregistered }. It NEVER rejects:
 * a push failure must not take down the morning notify path, and the caller
 * decides what to do (fall back to SMS, prune the token) from the fields.
 *
 * `unregistered` is true when Apple says this token is dead — 410 Unregistered,
 * or 400 BadDeviceToken — which is the prune signal from §4.12.
 */
function sendPush(opts) {
  return new Promise(function(resolve) {
    if (!apnsConfigured()) {
      return resolve({ ok: false, status: 0, reason: 'ApnsNotConfigured', unregistered: false, host: null });
    }
    // The ONE fact that decides an environment question: which gateway did
    // this actually dial? It was previously only inferable from the
    // environment we passed in, which is exactly the value under suspicion
    // whenever anyone is asking. Every result carries it now.
    var host = HOSTS[opts.environment === 'sandbox' ? 'sandbox' : 'production'];
    var client;
    try {
      client = http2.connect(host);
    } catch (e) {
      return resolve({ ok: false, status: 0, reason: 'ConnectFailed:' + e.message, unregistered: false, host: host });
    }

    var settled = false;
    // A HARD deadline over the whole operation. http2.connect() has no timeout
    // of its own, so an APNs that is unreachable at the network level (rather
    // than refusing) leaves the connect pending forever — and this is awaited
    // on the 5 AM path, so "forever" would mean the morning notification never
    // goes out at all. This guarantees the promise settles no matter what
    // http2, DNS, or TLS decide to do.
    var deadline = setTimeout(function() {
      finish({ ok: false, status: 0, reason: 'Deadline', unregistered: false });
    }, OVERALL_TIMEOUT_MS);
    if (deadline.unref) deadline.unref();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { client.close(); } catch (e) { /* already gone */ }
      // Stamped here rather than at each call site so no path can return a
      // result that does not say where it went.
      result.host = host;
      resolve(result);
    }

    client.on('error', function(e) {
      finish({ ok: false, status: 0, reason: 'ConnectionError:' + e.message, unregistered: false });
    });

    var body = JSON.stringify(opts.payload);
    // Signing can throw — a malformed key is the likeliest cause, and it used
    // to escape the executor, leaving the client socket open and the caller
    // with a rejection instead of a result.
    var bearer;
    try {
      bearer = providerToken();
    } catch (e) {
      return finish({ ok: false, status: 0, reason: 'SigningFailed:' + e.message.slice(0, 60), unregistered: false });
    }
    var headers = {
      ':method': 'POST',
      ':path': '/3/device/' + opts.token,
      'authorization': 'bearer ' + bearer,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      // Time Sensitive breaks through Focus and scheduled summary, which is
      // the whole point at 5 AM. Critical Alerts would bypass silent mode too,
      // but Apple scopes that entitlement to health and public safety and does
      // not grant it for this, so Time Sensitive is the ceiling here.
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    };
    if (opts.collapseId) headers['apns-collapse-id'] = String(opts.collapseId).slice(0, 64);
    if (opts.expirationEpochSeconds) headers['apns-expiration'] = String(opts.expirationEpochSeconds);

    var req;
    try {
      req = client.request(headers);
    } catch (e) {
      return finish({ ok: false, status: 0, reason: 'RequestFailed:' + e.message, unregistered: false });
    }

    var status = 0, apnsId = null, data = '';
    req.setTimeout(REQUEST_TIMEOUT_MS, function() {
      try { req.close(http2.constants.NGHTTP2_CANCEL); } catch (e) { /* noop */ }
      finish({ ok: false, status: 0, reason: 'Timeout', unregistered: false });
    });
    req.on('response', function(h) {
      status = h[':status'];
      apnsId = h['apns-id'] || null;
    });
    req.on('data', function(chunk) { data += chunk; });
    req.on('error', function(e) {
      finish({ ok: false, status: status, reason: 'StreamError:' + e.message, unregistered: false });
    });
    req.on('end', function() {
      var reason = null;
      if (data) {
        try { reason = JSON.parse(data).reason || null; } catch (e) { reason = data.slice(0, 120); }
      }
      // Apple's own words for "this token is gone". Both are prune signals.
      var unregistered = (status === 410 && reason === 'Unregistered') ||
                         (status === 400 && reason === 'BadDeviceToken');
      // A stale provider token is recoverable — drop the cache so the next
      // send mints a new one rather than repeating the same rejection.
      if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) {
        resetProviderToken();
      }
      finish({ ok: status === 200, status: status, apnsId: apnsId, reason: reason, unregistered: unregistered });
    });
    req.end(body);
  });
}

// ---- ENVIRONMENT FALLBACK (2026-09-04) ----
// A token is issued for exactly one APNs environment, and only the app knows
// which — so device_tokens.environment is whatever the CLIENT claimed at
// registration. On 2026-09-04 that claim was wrong for every live token in
// the fleet: a TestFlight build (production tokens) registered itself as
// 'sandbox', we dutifully sent to api.sandbox.push.apple.com, and Apple
// answered BadEnvironmentKeyInToken. Push was broken for 100% of devices and
// the only reason anyone was told anything is that the SMS fallback caught
// it.
//
// So the claim is now a HINT, not an instruction. We try production first —
// every TestFlight and App Store install is production, so that is the right
// guess for the real fleet — and on an environment-shaped rejection we try
// the other one. The caller persists whichever actually worked, so the fleet
// self-corrects without waiting on an app release. The server does not ship
// on Apple's schedule; this class of bug should not be able to need one.
//
// Only these two reasons trigger the retry:
//   BadEnvironmentKeyInToken — Apple naming this exact mistake
//   BadDeviceToken           — what Apple returns when a token is valid but
//                              addressed to the wrong environment, which is
//                              indistinguishable from a genuinely dead token
//                              until you have tried both
// Nothing else retries. A timeout, a connection error or a 403 is not an
// environment question, and retrying those would be guessing.
var ENV_RETRY_REASONS = ['BadEnvironmentKeyInToken', 'BadDeviceToken'];

function isEnvironmentMismatch(result) {
  return !!result && result.ok !== true && ENV_RETRY_REASONS.indexOf(result.reason) >= 0;
}

function otherEnvironment(env) {
  return env === 'sandbox' ? 'production' : 'sandbox';
}

/**
 * Send, trying both APNs environments before giving up.
 *
 * `sender` is injected so this is testable without touching Apple.
 * `opts.environment` is the stored claim and is used ONLY to pick which
 * environment to try second; the first attempt is always production unless
 * `opts.preferStored` is set.
 *
 * Resolves to the winning result, plus:
 *   environmentUsed  — the environment that actually worked (or the last tried)
 *   environmentFixed — true when that differs from the stored claim, i.e. the
 *                      caller should persist the correction
 *   attempts         — [{ environment, ok, status, reason }] for logging
 *
 * SAFETY: it retries ONLY when the first attempt failed with an
 * environment-shaped reason. A success returns immediately and is never
 * followed by a second send, so this cannot deliver the same notification
 * twice. (The two environments address disjoint device sets anyway — a token
 * lives in one or the other — but the guard is explicit rather than relying
 * on that.)
 */
async function sendPushBothEnvironments(sender, opts) {
  var stored = opts.environment === 'sandbox' ? 'sandbox' : 'production';
  var first = opts.preferStored ? stored : 'production';
  var attempts = [];

  var r1 = await sender(Object.assign({}, opts, { environment: first }));
  attempts.push({ environment: first, host: r1.host || null, ok: !!r1.ok, status: r1.status, reason: r1.reason });
  if (r1.ok || !isEnvironmentMismatch(r1)) {
    return Object.assign({}, r1, {
      environmentUsed: first,
      environmentFixed: r1.ok === true && first !== stored,
      attempts: attempts
    });
  }

  var second = otherEnvironment(first);
  var r2 = await sender(Object.assign({}, opts, { environment: second }));
  attempts.push({ environment: second, host: r2.host || null, ok: !!r2.ok, status: r2.status, reason: r2.reason });
  return Object.assign({}, r2, {
    environmentUsed: second,
    environmentFixed: r2.ok === true && second !== stored,
    // A token is only genuinely dead once BOTH environments have refused it.
    // Pruning on the first BadDeviceToken is what would have killed a
    // perfectly good token that was merely addressed to the wrong host.
    unregistered: !!r2.unregistered && !!r1.unregistered,
    attempts: attempts
  });
}

// Alert payload. `deliveryId` travels in the custom data so the app can ack
// the exact delivery it opened, which is what stops the SMS fallback.
function buildPayload(opts) {
  return {
    aps: {
      alert: { title: opts.title, body: opts.body },
      sound: 'default',
      // Time Sensitive — see the header comment above.
      'interruption-level': 'time-sensitive',
      'relevance-score': opts.mustTest ? 1 : 0.5
    },
    deliveryId: opts.deliveryId || null,
    result: opts.result || null,
    date: opts.date || null,
    // True when GET /today will return this result right now, so the app
    // can rewrite the widget snapshot the moment the push lands rather than
    // waiting on the widget's own timeline budget.
    resultAvailable: !!opts.resultAvailable
  };
}

module.exports = {
  apnsConfigured: apnsConfigured,
  sendPush: sendPush,
  sendPushBothEnvironments: sendPushBothEnvironments,
  isEnvironmentMismatch: isEnvironmentMismatch,
  ENV_RETRY_REASONS: ENV_RETRY_REASONS,
  buildPayload: buildPayload,
  resetProviderToken: resetProviderToken,
  HOSTS: HOSTS
};
