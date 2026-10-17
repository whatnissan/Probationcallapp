const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const a = require('../lib/appstore');
const st = require('../lib/subscription-state');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// App Store In-App Purchase (build 23). Dave's rulings, 2026-10-15:
// refunds take credits back to no lower than zero and flag the account;
// REFUND_REVERSED gives them back; Sandbox purchases grant on ANY account
// (revised 2026-10-17) up to 150 lifetime credits (demo and internal exempt),
// and are never revenue, commission, a purchase for the referral rule, or a
// duplicate subscription; commission is 20% of NET; two subscriptions are
// reported, never cancelled; products are the subscription (31) and packs
// of 30, served from /pricing — matching the website's subscription (31)
// and one-time month pass (30); 90 and 182 are website-only (2026-10-16).

test('the catalogue: the subscription at the server\'s per-payment count, and one pack of 30', () => {
  const cat = a.productCatalogue(31);
  assert.deepStrictEqual(cat, [
    { productId: 'com.probationcall.app.subscription.monthly', kind: 'subscription', credits: 31 },
    { productId: 'com.probationcall.app.credits.30', kind: 'credits', credits: 30 }
  ]);
  assert.strictEqual(a.productFor(cat, 'com.probationcall.app.credits.30').credits, 30);
  assert.strictEqual(a.productFor(cat, 'com.probationcall.app.credits.31'), null, 'replaced by .30 (2026-10-16)');
  assert.strictEqual(a.productFor(cat, 'com.probationcall.app.credits.90'), null, '90 is website-only (2026-10-16)');
  assert.strictEqual(a.productFor(cat, 'com.probationcall.app.credits.182'), null, '182 is website-only (2026-10-16)');
  assert.strictEqual(a.productFor(cat, 'com.probationcall.app.credits.1000'), null, 'nothing the server does not sell');
  assert.match(server, /appstoreRules\.productCatalogue\(SUBSCRIPTION_CREDITS_PER_PAYMENT\)/, 'one number for both kinds of subscription');
  assert.match(server, /appStore: \{ products: appStoreProducts\(\) \}/, '/pricing serves it');
  // The App Store matches the website exactly: the pack is the month pass's
  // 30, the subscription is the Stripe subscription's per-payment count.
  assert.match(server, /metadata: \{ user_id: req\.user\.id, package_id: 'month_pass', credits: '30' \}/);
  assert.strictEqual(cat.find((p) => p.kind === 'credits').credits, 30);
  assert.match(server, /const SUBSCRIPTION_CREDITS_PER_PAYMENT = 31;/);
});

const prodUSD = (price) => ({ environment: 'Production', currency: 'USD', price: price });

test('revenue is Production US dollars only', () => {
  assert.strictEqual(a.usdCents(prodUSD(14990)), 1499);
  assert.strictEqual(a.usdCents({ environment: 'Sandbox', currency: 'USD', price: 14990 }), null, 'a Sandbox grant is not revenue');
  assert.strictEqual(a.usdCents({ environment: 'Production', currency: 'EUR', price: 14990 }), null, 'a euro is not a cent');
  assert.strictEqual(a.usdCents({ environment: 'Production', currency: 'USD' }), null);
});

test('commission is 20% of what is left after Apple\'s 15%', () => {
  // $14.99: Apple keeps $2.25, we receive $12.74, the affiliate gets $2.54 (gross would be $3.00).
  assert.strictEqual(a.netCommissionCents(prodUSD(14990), 20), 254);
  assert.strictEqual(a.netCommissionCents(prodUSD(14990), 20, 30), 209, 'the rate if the Small Business Program does not apply');
  assert.strictEqual(a.netCommissionCents({ environment: 'Sandbox', currency: 'USD', price: 14990 }, 20), 0);
  assert.strictEqual(a.netCommissionCents({ environment: 'Production', currency: 'GBP', price: 14990 }, 20), 0);
  assert.strictEqual(a.APPLE_COMMISSION_PERCENT, 15);
});

test('the Sandbox cap: 150 lifetime credits, a grant only if it fits whole', () => {
  assert.strictEqual(a.SANDBOX_LIFETIME_CREDIT_CAP, 150);
  assert.strictEqual(a.sandboxCapAllows(0, 30), true);
  assert.strictEqual(a.sandboxCapAllows(120, 30), true, '150 exactly');
  assert.strictEqual(a.sandboxCapAllows(124, 30), false, 'nothing in part');
  assert.strictEqual(a.sandboxCapAllows(119, 31), true, 'a renewal that lands on 150');
  assert.strictEqual(a.sandboxCapAllows(150, 31), false);
});

test('a refund takes back the credits, or the refunded share of a prorated one', () => {
  assert.strictEqual(a.refundCredits(90, 'REFUND_FULL'), 90);
  assert.strictEqual(a.refundCredits(90, undefined), 90, 'no type reads as full');
  assert.strictEqual(a.refundCredits(90, 'FAMILY_REVOKE'), 90);
  assert.strictEqual(a.refundCredits(90, 'REFUND_PRORATED', 50000), 45);
  assert.strictEqual(a.refundCredits(31, 'REFUND_PRORATED', 33333), 10, 'rounded down — the person keeps the fraction');
  assert.strictEqual(a.isFullRefund('REFUND_FULL'), true);
  assert.strictEqual(a.isFullRefund('REFUND_PRORATED'), false, 'a partial refund leaves the commission, as Stripe does');
});

test('Apple\'s subscription states map onto §3\'s three', () => {
  assert.strictEqual(a.subscriptionStatus(1), 'active');
  assert.strictEqual(a.subscriptionStatus(3), 'past_due', 'billing retry');
  assert.strictEqual(a.subscriptionStatus(4), 'past_due', 'grace period');
  assert.strictEqual(a.subscriptionStatus(2), 'canceled', 'expired');
  assert.strictEqual(a.subscriptionStatus(5), 'canceled', 'revoked');
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.strictEqual(a.subscriptionStatus(null, { expiresDate: now + 86400000 }, now), 'active');
  assert.strictEqual(a.subscriptionStatus(null, { expiresDate: now - 1 }, now), 'canceled');
  assert.strictEqual(a.subscriptionStatus(null, { expiresDate: now + 86400000, revocationDate: now }, now), 'canceled');
});

test('a notification becomes a patch to the subscription row', () => {
  const tx = { transactionId: '2000000456', expiresDate: Date.parse('2026-11-15T12:00:00Z') };
  assert.deepStrictEqual(a.subscriptionPatch('DID_RENEW', 1, tx, { autoRenewStatus: 1 }),
    { status: 'active', auto_renew: true, expires_at: '2026-11-15T12:00:00.000Z', last_transaction_id: '2000000456' });
  assert.strictEqual(a.subscriptionPatch('DID_CHANGE_RENEWAL_STATUS', 1, tx, { autoRenewStatus: 0 }).auto_renew, false, 'cancel at period end');
  assert.strictEqual(a.subscriptionPatch('DID_FAIL_TO_RENEW', undefined, tx, null).status, 'past_due');
  assert.strictEqual(a.subscriptionPatch('EXPIRED', undefined, tx, null).status, 'canceled');
  assert.strictEqual(a.subscriptionPatch('DID_RENEW', 3, tx, null).status, 'past_due', 'Apple\'s own status wins when present');
});

const jws = (payload) => 'e30.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.sig';

test('the environment claim only chooses the verifier', () => {
  assert.strictEqual(a.claimedEnvironment(jws({ environment: 'Sandbox' })), 'Sandbox');
  assert.strictEqual(a.claimedEnvironment(jws({ data: { environment: 'Production' } }), true), 'Production');
  assert.strictEqual(a.claimedEnvironment('not.a.jws'), null);
});

function fakeLibrary(log) {
  class SignedDataVerifier {
    constructor(roots, online, env, bundleId, appAppleId) { this.env = env; log.push(['verifier', env, bundleId, appAppleId, online]); }
    async verifyAndDecodeTransaction(s) {
      const body = JSON.parse(Buffer.from(s.split('.')[1], 'base64url').toString());
      if (body.environment !== this.env) { const e = new Error('env'); e.status = 4; throw e; }
      if (body.fail) { const e = new Error('x'); e.status = body.fail; throw e; }
      return body;
    }
  }
  return { SignedDataVerifier, Environment: { PRODUCTION: 'Production', SANDBOX: 'Sandbox' },
    VerificationStatus: { RETRYABLE_VERIFICATION_FAILURE: 2 }, AppStoreServerAPIClient: class {} };
}

test('verification: each environment has its own verifier, and failures say whether to retry', async () => {
  const log = [];
  const store = a.createAppStore({ library: fakeLibrary(log), bundleId: 'com.probationcall.app', appAppleId: '6700000000', rootCertificates: [Buffer.from('x')] });
  assert.strictEqual((await store.verifyTransaction(jws({ environment: 'Production', transactionId: '1' }))).transactionId, '1');
  assert.strictEqual((await store.verifyTransaction(jws({ environment: 'Sandbox', transactionId: '2' }))).transactionId, '2');
  assert.deepStrictEqual(log, [['verifier', 'Production', 'com.probationcall.app', 6700000000, true], ['verifier', 'Sandbox', 'com.probationcall.app', undefined, true]]);
  await assert.rejects(store.verifyTransaction(jws({ environment: 'Production', fail: 1 })), (e) => e.appStoreCode === 'invalid' && !e.retryable);
  await assert.rejects(store.verifyTransaction(jws({ environment: 'Production', fail: 2 })), (e) => e.appStoreCode === 'retryable' && e.retryable);
  await assert.rejects(store.verifyTransaction(jws({ environment: 'Xcode' })), (e) => e.appStoreCode === 'invalid');
  await assert.rejects(store.verifyTransaction('garbage'), (e) => e.appStoreCode === 'invalid');
  const unconfigured = a.createAppStore({ library: fakeLibrary([]), bundleId: 'b', rootCertificates: [Buffer.from('x')] });
  await assert.rejects(unconfigured.verifyTransaction(jws({ environment: 'Production' })), (e) => e.appStoreCode === 'not_configured' && e.retryable,
    'no app Apple ID: Production cannot be verified, and the app should try again later');
  assert.strictEqual(fs.readdirSync(path.join(__dirname, '..', 'certs', 'apple')).filter((f) => f.endsWith('.cer')).length, 3, 'Apple root certificates are in the repo');
});

test('the .p8 key is accepted however it was pasted', () => {
  const pem = a.normalisePem('-----BEGIN PRIVATE KEY-----\\nMIGTAgEAMBMG\\nByqGSM49\\n-----END PRIVATE KEY-----');
  assert.strictEqual(pem, '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----\n');
  assert.strictEqual(a.normalisePem(''), null);
});

const STRIPE_ACTIVE = { subscription_status: 'active', subscription_cancel_at_period_end: false, subscription_current_period_end: '2026-11-01T00:00:00Z' };
const APPLE = (o) => Object.assign({ status: 'active', auto_renew: true, expires_at: '2026-11-10T00:00:00Z', environment: 'Production' }, o);

test('one subscription answer, whichever store it came from', () => {
  assert.strictEqual(st.effectiveSubscription({}, []), null, 'never subscribed');
  assert.deepStrictEqual(st.effectiveSubscription(STRIPE_ACTIVE, []),
    { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-11-01T00:00:00Z', source: 'stripe', duplicate: null });
  assert.deepStrictEqual(st.effectiveSubscription({}, [APPLE({ auto_renew: false })]),
    { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-11-10T00:00:00Z', source: 'apple', duplicate: null });
  const both = st.effectiveSubscription(STRIPE_ACTIVE, [APPLE()]);
  assert.deepStrictEqual(both.duplicate, { source: 'apple', currentPeriodEnd: '2026-11-10T00:00:00Z' }, 'both active: reported, neither hidden');
  assert.strictEqual(st.effectiveSubscription({ subscription_status: 'canceled', subscription_current_period_end: '2026-09-01T00:00:00Z' }, [APPLE()]).source, 'apple', 'the active one speaks');
  assert.strictEqual(st.effectiveSubscription({ subscription_status: 'past_due' }, [APPLE({ status: 'canceled', expires_at: '2026-01-01T00:00:00Z' })]).status, 'past_due');
  // Sandbox (2026-10-17): it counts for ANY account — App Review subscribes
  // in Sandbox on whatever account it uses, and must see the subscription —
  // but it is never "paying twice", and a real one outranks it.
  assert.strictEqual(st.effectiveSubscription({}, [APPLE({ environment: 'Sandbox' })]).source, 'apple');
  const withSandbox = st.effectiveSubscription(STRIPE_ACTIVE, [APPLE({ environment: 'Sandbox' })]);
  assert.strictEqual(withSandbox.source, 'stripe');
  assert.strictEqual(withSandbox.duplicate, null, 'a Sandbox subscription charges nothing');
  assert.strictEqual(st.effectiveSubscription({}, [APPLE({ environment: 'Sandbox', expires_at: '2027-01-01T00:00:00Z' }), APPLE()]).currentPeriodEnd,
    '2026-11-10T00:00:00Z', 'a Production subscription speaks before a Sandbox one');
  assert.strictEqual(st.isRenewingSubscriber(st.effectiveSubscription({}, [APPLE({ auto_renew: false })])), false);
  assert.strictEqual(st.isRenewingSubscriber(st.effectiveSubscription({}, [APPLE()])), true);
});

function slice(start) {
  const i = server.indexOf(start);
  assert.ok(i > 0, start + ' should be findable');
  return server.slice(i, server.indexOf('\n});', i)).replace(/\/\/.*$/gm, '');
}

test('wiring: every subscriber question goes through the merged state', () => {
  assert.match(server, /subscription: await subscriptionStateFor\(req\.user\.id, profile\),/, '/me');
  assert.match(server, /subscriberQuiet = subscriptionState\.isRenewingSubscriber\(await subscriptionStateFor\(userId, subProf\.data\)\);/, 'low-credit quiet rule');
  assert.match(server, /var pauseNotice = await pauseNoticeForUser\(userId, profile\);/, 'Montgomery pause wording');
  assert.match(server, /var ftPauseNotice = await pauseNoticeForUser\(userId, profile\);/, 'Fort Bend pause wording');
  assert.ok(!/pauseNoticeFor\(profile\)\.message/.test(server), 'no caller skips the merged state');
  assert.match(slice("app.post('/api/v1/billing-portal'"), /v1Error\(res, 409, 'managed_by_apple'/);
  assert.match(server, /You already subscribe through the App Store\./, 'Stripe checkout refuses a second subscription');
  assert.match(server, /if \(billingReason === 'subscription_create'\) await checkDuplicateSubscriptions\(profile\.id\);/);
});

test('wiring: only App Store grants send the Apple key to the ledger', () => {
  const fn = server.slice(server.indexOf('async function recordCreditAdd('), server.indexOf('// Un-pause a schedule that WE paused'));
  assert.match(fn, /\}, opts\.appleTransactionId \? \{[\s\S]*p_apple_transaction_id: String\(opts\.appleTransactionId\)[\s\S]*\} : \{\}\)\);/);
  const grant = server.slice(server.indexOf('async function grantAppleTransaction('), server.indexOf('async function applyAppleRefund('));
  assert.match(grant, /appleTransactionId: String\(tx\.transactionId\)/, 'keyed on transactionId, never originalTransactionId');
  assert.ok(!/appleTransactionId: String\(tx\.originalTransactionId\)/.test(grant));
  assert.ok(!/sandboxGrantAllowed/.test(grant), 'Sandbox grants on any account (2026-10-17), not only demo/internal');
  assert.match(grant, /if \(!production && !sandboxCapExempt\(profile\)\) \{/, 'the lifetime cap, with the exemption');
  assert.match(grant, /\.eq\('user_id', profile\.id\)\.eq\('apple_environment', 'Sandbox'\)/, 'counted from the account\'s Sandbox purchases — renewals included');
  assert.match(grant, /return \{ outcome: 'sandbox_not_granted', creditsGranted: 0, balance: profile\.credits \|\| 0 \};/);
  assert.match(grant, /var seen = sbxRows\.some\(function\(r\) \{ return r\.apple_transaction_id === String\(tx\.transactionId\); \}\);/,
    'a re-post of a granted transaction is not refused by the cap');
  assert.ok(grant.indexOf("outcome: 'sandbox_not_granted'") < grant.indexOf('await recordCreditAdd('), 'checked before anything is granted');
  const exempt = server.slice(server.indexOf('function sandboxCapExempt('), server.indexOf('// One subscription answer for this account'));
  assert.match(exempt, /profile\.is_demo === true \|\| \(!!email && isDev\(email\)\) \|\| internalAccountEmails\(\)\.indexOf\(email\) >= 0/);
  assert.match(grant, /amount_cents: appstoreRules\.usdCents\(tx\)/, 'and is recorded with no revenue (NULL outside Production USD)');
  assert.match(grant, /apple_environment: tx\.environment/);
  assert.match(grant, /if \(isNew && production\) await accrueAppleCommission/, 'no commission on Sandbox or a repeat');
  const acc = server.slice(server.indexOf('async function accrueAppleCommission('), server.indexOf('async function checkDuplicateSubscriptions('));
  assert.match(acc, /var rate = AFFILIATE_COMMISSION_PERCENT_RECURRING;/, 'the 30 pack pays the month pass\'s (subscription) rate');
  assert.ok(!/AFFILIATE_COMMISSION_PERCENT_ONETIME/.test(acc));
});

test('a Sandbox purchase is not a purchase: referral rule, duplicate check, admin numbers', () => {
  assert.match(server, /from\('purchases'\)\.select\('id'\)\.eq\('user_id', userId\)\s*\.or\('apple_environment\.is\.null,apple_environment\.neq\.Sandbox'\)\.limit\(1\)/,
    'the referral after-purchase rule ignores Sandbox rows');
  const dup = server.slice(server.indexOf('async function checkDuplicateSubscriptions('), server.indexOf('async function grantAppleTransaction('));
  assert.match(dup, /filter\(function\(r\) \{ return r\.environment === 'Production'; \}\)/, 'only a Production App Store subscription is paying twice');
  assert.match(server, /var revenueSum = await sumColumn\('purchases', 'amount_cents'\);/, 'admin revenue sums amount_cents, which is NULL for Sandbox');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(admin, /p\.apple_environment==="Sandbox"[\s\S]{0,200}Sandbox · not revenue/);
  assert.match(admin, /p\.source==="apple_iap"[\s\S]{0,300}Refund via Apple/, 'no Stripe refund button on an App Store row');
});

test('wiring: refunds never go below zero, and Apple purchases are refunded only by Apple', () => {
  const refund = server.slice(server.indexOf('async function applyAppleRefund('), server.indexOf('async function applyAppleRefundReversed('));
  assert.match(refund, /supabase\.rpc\('deduct_credits_capped'/, 'the capped deduction: greatest(0, …)');
  assert.match(refund, /\.is\('refunded_at', null\)\.select\('id'\)/, 'one delivery claims the refund');
  assert.match(refund, /billing_flagged_at: now/);
  assert.match(refund, /await recordReviewFlag\(\{\s*user_id: p\.user_id, reason: 'apple_refund',/, 'and into the review list, so the daily digest shows it');
  assert.match(server, /if \(purchase\.source === 'apple_iap'\) \{\s*return res\.status\(400\)/);
});

test('account deletion is untouched (Dave: on hold for the Privacy Policy)', () => {
  const del = slice("app.delete('/api/v1/account'");
  assert.ok(!/apple/i.test(del), 'no App Store handling added to the deletion path');
  const m072 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '072_apple_subscriptions.sql'), 'utf8');
  assert.match(m072, /user_id\s+uuid REFERENCES profiles\(id\) ON DELETE SET NULL/, 'deleting a profile keeps the row for later notifications');
});

test('credits never expire: the only things that lower a balance are known', () => {
  // Dave, 2026-10-15: confirm nothing expires credits. Every path that lowers
  // profiles.credits is one of these; a new one must be added here on purpose.
  const lowering = (server.match(/rpc\('deduct_[a-z_]+'/g) || []).sort();
  assert.deepStrictEqual([...new Set(lowering)], ["rpc('deduct_credit_with_ledger'", "rpc('deduct_credits_capped'"]);
  assert.deepStrictEqual((server.match(/\.from\('profiles'\)\.update\(\{ credits: /g) || []).length, 1, 'the admin "lower balance" action');
  assert.ok(!/expire[sd]?_credits|credits_expire|creditExpir/i.test(server), 'no expiry of credits anywhere');
});
