'use strict';

// Billing / subscription-recovery helpers, extracted from server.js so they
// can be unit-tested. All Stripe + Supabase access is injected through
// createBilling(deps) — tests run against mocks, never live services.

var SUBSCRIPTION_STATUSES_TREATED_AS_EXISTS = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

// Structured Stripe error logging. Stripe errors carry type/code/decline_code
// that e.message alone drops — and the Stripe-hosted pages show users only a
// generic "Something went wrong", so this log line is the ONLY place the real
// failure reason (e.g. a Cash App mandate/config rejection) is visible.
function logStripeError(context, e) {
  console.error('[STRIPE ERROR] ' + context + ':',
    'type=' + (e.type || 'n/a'),
    'code=' + (e.code || 'n/a'),
    'decline_code=' + (e.decline_code || 'n/a'),
    'status=' + (e.statusCode || 'n/a'),
    'message=' + ((e.raw && e.raw.message) || e.message));
}

function createBilling(deps) {
  var stripe = deps.stripe;
  var supabase = deps.supabase;

  // Conflict-tolerant profile write for Stripe id backfills. The partial
  // unique indexes on profiles.stripe_customer_id / stripe_subscription_id
  // mean any write-back of a resolved id can collide with another profile
  // that already holds it. Persistence here is ALWAYS best-effort: on error
  // the id fields are dropped and the non-id fields are retried alone, and
  // the conflict is logged with the profile that currently owns the id so it
  // can be reconciled by hand. Callers must never let a failure here block
  // the user-facing action. Returns { persisted, matched, idsDropped } —
  // matched is how many rows the (possibly preconditioned) update actually
  // hit; 0 with persisted=true means the precondition filtered it out
  // (e.g. a compare-and-swap lost the race).
  async function updateProfileTolerant(opts) {
    var userId = opts.userId;
    var safeFields = opts.safeFields || {};
    var idFields = opts.idFields || {};
    var label = opts.label || 'profile update';
    async function attempt(fields) {
      var q = supabase.from('profiles').update(fields).eq('id', userId);
      if (opts.precondition) q = opts.precondition(q);
      return await q.select('id');
    }
    var r = await attempt(Object.assign({}, safeFields, idFields));
    if (!r.error) return { persisted: true, matched: (r.data || []).length, idsDropped: false };
    // Diagnose the collision: which profile currently owns each conflicting id?
    var idKeys = Object.keys(idFields);
    for (var i = 0; i < idKeys.length; i++) {
      if (!idFields[idKeys[i]]) continue;
      try {
        var owner = await supabase.from('profiles').select('id, email').eq(idKeys[i], idFields[idKeys[i]]).maybeSingle();
        if (owner.data && owner.data.id !== userId) {
          console.warn('[STRIPE][WARN] ' + label + ': ' + idKeys[i] + '=' + idFields[idKeys[i]] + ' already belongs to profile ' + owner.data.id + ' (' + owner.data.email + '); wanted it on profile ' + userId + ' — reconcile manually');
        }
      } catch (ignored) {}
    }
    console.error('[STRIPE] ' + label + ': profile write failed for ' + userId.slice(0, 8) + ':', r.error.message || r.error);
    if (Object.keys(safeFields).length === 0) return { persisted: false, matched: 0, idsDropped: true };
    var r2 = await attempt(safeFields);
    if (r2.error) {
      console.error('[STRIPE] ' + label + ': non-id retry ALSO failed for ' + userId.slice(0, 8) + ':', r2.error.message || r2.error);
      return { persisted: false, matched: 0, idsDropped: true };
    }
    return { persisted: true, matched: (r2.data || []).length, idsDropped: true };
  }

  // Resolve the Stripe customer for a profile, creating one if needed, and
  // persist the id back to the profile (best-effort). Resolution order:
  //   1. profiles.stripe_customer_id — trusted, used directly.
  //   2. Stripe customer SEARCH on metadata.user_id === this Supabase UUID.
  //      Adopted only if exactly one customer matches; an ambiguous
  //      multi-match is logged and NOT adopted.
  //   3. Create a new customer tagged with metadata.user_id, idempotency-
  //      keyed on the user id so a double-tapped portal request can't mint
  //      duplicates.
  // Email is deliberately NOT a resolution key. A Billing Portal session
  // exposes invoice history, saved payment methods, and cancellation for
  // whatever customer we hand it — adopting an email-only match would link
  // accounts across shared household emails, changed emails, and stale
  // duplicate customers. Email matches are LOGGED (never adopted) so we can
  // measure how often they occur before deciding whether to reconcile them
  // manually.
  async function resolveStripeCustomer(profile) {
    if (profile.stripe_customer_id) return profile.stripe_customer_id;
    var customerId = null;
    var hits = [];
    try {
      var search = await stripe.customers.search({
        query: "metadata['user_id']:'" + profile.id + "'",
        limit: 2
      });
      hits = search.data || [];
    } catch (searchErr) {
      // Degrade to create rather than dead-ending the billing action: worst
      // case is a fresh (possibly duplicate) customer, which the idempotency
      // key bounds. Log loudly — a failing search here means every sub-less
      // user is skipping recovery.
      logStripeError('resolveStripeCustomer metadata search (user ' + profile.id.slice(0, 8) + ') — degrading to create', searchErr);
    }
    if (hits.length === 1) {
      customerId = hits[0].id;
      console.warn('[STRIPE][WARN] resolveStripeCustomer: recovered customer ' + customerId + ' for user ' + profile.id.slice(0, 8) + ' via metadata.user_id search (profile had no stripe_customer_id)');
    } else if (hits.length > 1) {
      console.warn('[STRIPE][WARN] resolveStripeCustomer: multiple Stripe customers carry metadata.user_id=' + profile.id + ' (' + hits.map(function(c) { return c.id; }).join(', ') + ') — ambiguous, NOT adopting any; creating a fresh customer. Reconcile manually.');
    } else {
      // Visibility only: is there an email match we are refusing to adopt?
      try {
        var byEmail = await stripe.customers.list({ email: profile.email, limit: 1 });
        if (byEmail.data && byEmail.data.length > 0) {
          console.warn('[STRIPE][WARN] resolveStripeCustomer: email-only Stripe customer ' + byEmail.data[0].id + ' exists for ' + profile.email + ' (user ' + profile.id.slice(0, 8) + ') but lacks matching metadata.user_id — NOT adopted; creating a fresh customer.');
        }
      } catch (listErr) {
        logStripeError('resolveStripeCustomer email-visibility check', listErr);
      }
    }
    if (!customerId) {
      var created = await stripe.customers.create(
        { email: profile.email, metadata: { user_id: profile.id } },
        { idempotencyKey: 'cust-create-' + profile.id }
      );
      customerId = created.id;
    }
    await updateProfileTolerant({
      userId: profile.id,
      idFields: { stripe_customer_id: customerId },
      label: 'resolveStripeCustomer persist'
    });
    return customerId;
  }

  // Apply a subscription-driven profile update, trying three match paths in
  // order. Fallback paths log at WARN with the mechanism that resolved the
  // event, so production logs show which path is carrying the load.
  async function applySubscriptionProfileUpdate(subscription, fields, label) {
    // Path 1 (normal): direct match on stripe_subscription_id. Quiet on success.
    var r = await supabase.from('profiles')
      .update(fields)
      .eq('stripe_subscription_id', subscription.id)
      .select('id');
    if (r.error) {
      console.error('[STRIPE WEBHOOK] ' + label + ' update failed:', r.error);
      return;
    }
    if (r.data && r.data.length > 0) return;

    // Path 2: subscription.metadata.user_id — set via subscription_data.metadata
    // at Checkout since the first subscription commit, so every sub this app
    // created carries it. Backfills the ids so the next event takes path 1.
    var uid = subscription.metadata && subscription.metadata.user_id;
    if (uid) {
      var idFields = { stripe_subscription_id: subscription.id };
      if (subscription.customer) idFields.stripe_customer_id = subscription.customer;
      var res2 = await updateProfileTolerant({
        userId: uid,
        safeFields: fields,
        idFields: idFields,
        label: label + ' metadata-fallback'
      });
      if (res2.persisted && res2.matched > 0) {
        console.warn('[STRIPE WEBHOOK][WARN] ' + label + ': sub ' + subscription.id + ' resolved via METADATA fallback (user ' + uid.slice(0, 8) + ')' + (res2.idsDropped ? ' — id backfill dropped on conflict' : ''));
        return;
      }
      console.warn('[STRIPE WEBHOOK][WARN] ' + label + ': metadata.user_id ' + uid + ' matched no profile for sub ' + subscription.id + ' — trying customer-id fallback');
    }

    // Path 3: match by the event's customer id. Restricted to a profile whose
    // stripe_subscription_id is NULL — if the profile is already linked to a
    // DIFFERENT sub, this event concerns an old subscription and must not
    // clobber the current one's status.
    if (subscription.customer) {
      var byCust = await supabase.from('profiles')
        .select('id, stripe_subscription_id')
        .eq('stripe_customer_id', subscription.customer)
        .maybeSingle();
      if (byCust.data && !byCust.data.stripe_subscription_id) {
        var res3 = await updateProfileTolerant({
          userId: byCust.data.id,
          safeFields: fields,
          idFields: { stripe_subscription_id: subscription.id },
          // Re-assert NULL at write time so a concurrent event that just
          // linked a different sub to this profile isn't overwritten.
          precondition: function(q) { return q.is('stripe_subscription_id', null); },
          label: label + ' customer-fallback'
        });
        if (res3.persisted && res3.matched > 0) {
          console.warn('[STRIPE WEBHOOK][WARN] ' + label + ': sub ' + subscription.id + ' resolved via CUSTOMER fallback (profile ' + byCust.data.id.slice(0, 8) + ', customer ' + subscription.customer + ')');
          return;
        }
      } else if (byCust.data) {
        console.warn('[STRIPE WEBHOOK][WARN] ' + label + ': profile ' + byCust.data.id.slice(0, 8) + ' (customer ' + subscription.customer + ') is linked to a different sub ' + byCust.data.stripe_subscription_id + ' — refusing to apply event for sub ' + subscription.id);
        return;
      }
    }
    console.error('[STRIPE WEBHOOK] ' + label + ': could NOT route sub ' + subscription.id + ' (customer=' + (subscription.customer || 'n/a') + ') to any profile — flag NOT updated');
  }

  // Self-heal the profile's subscription fields from a live Stripe read using
  // status:'all', so a sub in past_due/unpaid/incomplete is visible and the
  // DB flag the banner reads matches what Stripe actually has. No-clobber:
  // the write is a compare-and-swap on the subscription_status the caller
  // read at request start — if a webhook moved it in between, the update
  // matches 0 rows and the webhook's (fresher) state stands.
  async function syncSubscriptionState(profile, customerId) {
    var subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    var live = (subs.data || []).find(function(sub) {
      return SUBSCRIPTION_STATUSES_TREATED_AS_EXISTS.indexOf(sub.status) !== -1;
    });
    if (!live) return { synced: false, hasSubscription: false };
    if (profile.stripe_subscription_id === live.id && profile.subscription_status === live.status) {
      return { synced: false, hasSubscription: true };
    }
    var priorStatus = profile.subscription_status;
    var syncRes = await updateProfileTolerant({
      userId: profile.id,
      safeFields: {
        subscription_status: live.status,
        subscription_cancel_at_period_end: !!live.cancel_at_period_end,
        subscription_cancel_at: live.cancel_at ? new Date(live.cancel_at * 1000).toISOString() : null
      },
      idFields: { stripe_subscription_id: live.id },
      precondition: function(q) {
        return (priorStatus === null || priorStatus === undefined)
          ? q.is('subscription_status', null)
          : q.eq('subscription_status', priorStatus);
      },
      label: 'portal self-heal sync'
    });
    if (syncRes.persisted && syncRes.matched === 0) {
      console.log('[SUBSCRIPTION] Portal self-heal skipped for ' + profile.id.slice(0, 8) + ' — subscription_status changed since read (webhook won)');
      return { synced: false, hasSubscription: true, lostRace: true };
    }
    if (syncRes.persisted) {
      console.log('[SUBSCRIPTION] Portal self-heal: user=' + profile.id.slice(0, 8) + ' sub=' + live.id + ' status=' + live.status + (syncRes.idsDropped ? ' (sub-id backfill dropped on conflict)' : ''));
    }
    return { synced: syncRes.persisted, hasSubscription: true };
  }

  // Full portal-open flow: resolve/create the customer, best-effort sync,
  // create the Billing Portal session. The sync can never block the portal —
  // a user must always be able to reach their payment methods.
  async function openBillingPortal(profile, returnUrl) {
    var customerId = await resolveStripeCustomer(profile);
    try {
      await syncSubscriptionState(profile, customerId);
    } catch (syncErr) {
      logStripeError('portal subscription sync (user ' + profile.id.slice(0, 8) + ')', syncErr);
    }
    var portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl
    });
    return { url: portal.url };
  }

  return {
    updateProfileTolerant: updateProfileTolerant,
    resolveStripeCustomer: resolveStripeCustomer,
    applySubscriptionProfileUpdate: applySubscriptionProfileUpdate,
    syncSubscriptionState: syncSubscriptionState,
    openBillingPortal: openBillingPortal
  };
}

module.exports = {
  createBilling: createBilling,
  logStripeError: logStripeError,
  SUBSCRIPTION_STATUSES_TREATED_AS_EXISTS: SUBSCRIPTION_STATUSES_TREATED_AS_EXISTS
};
