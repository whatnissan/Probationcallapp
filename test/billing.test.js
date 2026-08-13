const test = require('node:test');
const assert = require('node:assert');

const { createBilling } = require('../lib/billing');

// ---- mocks -----------------------------------------------------------------

// Chainable Supabase stub. Every executed query is recorded as
// { table, op, fields, filters, selectCols, maybeSingle } and answered by the
// test's respond(q) function, which returns { data, error }.
function fakeSupabase(respond) {
  var calls = [];
  return {
    calls: calls,
    from: function(table) {
      var q = { table: table, op: null, fields: null, filters: [], selectCols: null, maybeSingle: false };
      var pending = null;
      function exec() {
        if (!pending) { calls.push(q); pending = Promise.resolve(respond(q)); }
        return pending;
      }
      var chain = {
        update: function(f) { q.op = 'update'; q.fields = f; return chain; },
        select: function(cols) { if (q.op === null) q.op = 'select'; q.selectCols = cols; return chain; },
        eq: function(k, v) { q.filters.push(['eq', k, v]); return chain; },
        is: function(k, v) { q.filters.push(['is', k, v]); return chain; },
        maybeSingle: function() { q.maybeSingle = true; return exec(); },
        single: function() { q.maybeSingle = true; return exec(); },
        then: function(onFul, onRej) { return exec().then(onFul, onRej); }
      };
      return chain;
    }
  };
}

function hasFilter(q, kind, key, value) {
  return q.filters.some(function(f) { return f[0] === kind && f[1] === key && (arguments.length < 4 || f[2] === value); });
}

// Stripe stub: records every call; per-method behavior injected by the test.
function fakeStripe(cfg) {
  cfg = cfg || {};
  var calls = [];
  return {
    calls: calls,
    customers: {
      search: async function(p) {
        calls.push(['customers.search', p]);
        if (cfg.search) return cfg.search(p);
        return { data: [] };
      },
      list: async function(p) {
        calls.push(['customers.list', p]);
        if (cfg.list) return cfg.list(p);
        return { data: [] };
      },
      create: async function(p, opts) {
        calls.push(['customers.create', p, opts]);
        if (cfg.create) return cfg.create(p, opts);
        return { id: 'cus_created' };
      }
    },
    subscriptions: {
      list: async function(p) {
        calls.push(['subscriptions.list', p]);
        if (cfg.subsList) return cfg.subsList(p);
        return { data: [] };
      }
    },
    billingPortal: {
      sessions: {
        create: async function(p) {
          calls.push(['portal.create', p]);
          return { url: 'https://billing.stripe.com/session/test' };
        }
      }
    }
  };
}

function silenceConsole(t) {
  return {
    log: t.mock.method(console, 'log', function() {}),
    warn: t.mock.method(console, 'warn', function() {}),
    error: t.mock.method(console, 'error', function() {})
  };
}

function joinedCalls(mockFn) {
  return mockFn.mock.calls.map(function(c) { return c.arguments.join(' '); }).join('\n');
}

var UID = '11111111-2222-3333-4444-555555555555';

// ---- resolveStripeCustomer -------------------------------------------------

test('resolveStripeCustomer: saved stripe_customer_id is trusted — zero Stripe calls', async function(t) {
  silenceConsole(t);
  var stripe = fakeStripe();
  var supabase = fakeSupabase(function() { throw new Error('no DB access expected'); });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var id = await billing.resolveStripeCustomer({ id: UID, email: 'a@b.c', stripe_customer_id: 'cus_saved' });
  assert.strictEqual(id, 'cus_saved');
  assert.strictEqual(stripe.calls.length, 0);
  assert.strictEqual(supabase.calls.length, 0);
});

test('resolveStripeCustomer: exactly one metadata search hit is adopted and persisted', async function(t) {
  silenceConsole(t);
  var stripe = fakeStripe({ search: function() { return { data: [{ id: 'cus_meta' }] }; } });
  var supabase = fakeSupabase(function(q) {
    assert.strictEqual(q.op, 'update');
    assert.strictEqual(q.fields.stripe_customer_id, 'cus_meta');
    assert.ok(hasFilter(q, 'eq', 'id', UID));
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var id = await billing.resolveStripeCustomer({ id: UID, email: 'a@b.c', stripe_customer_id: null });
  assert.strictEqual(id, 'cus_meta');
  var created = stripe.calls.filter(function(c) { return c[0] === 'customers.create'; });
  assert.strictEqual(created.length, 0, 'must not create when search resolves');
  assert.strictEqual(supabase.calls.length, 1, 'adopted id persisted');
});

test('resolveStripeCustomer: 2+ metadata hits are ambiguous — not adopted, new customer created, WARN logged', async function(t) {
  var con = silenceConsole(t);
  var stripe = fakeStripe({
    search: function() { return { data: [{ id: 'cus_a' }, { id: 'cus_b' }] }; },
    create: function() { return { id: 'cus_fresh' }; }
  });
  var supabase = fakeSupabase(function() { return { data: [{ id: UID }], error: null }; });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var id = await billing.resolveStripeCustomer({ id: UID, email: 'a@b.c', stripe_customer_id: null });
  assert.strictEqual(id, 'cus_fresh');
  var warns = joinedCalls(con.warn);
  assert.match(warns, /ambiguous, NOT adopting/);
  assert.match(warns, /cus_a, cus_b/);
});

test('resolveStripeCustomer: zero metadata hits + email match — NOT adopted, WARN logged, new customer created', async function(t) {
  var con = silenceConsole(t);
  var stripe = fakeStripe({
    search: function() { return { data: [] }; },
    list: function() { return { data: [{ id: 'cus_email_only' }] }; },
    create: function() { return { id: 'cus_fresh' }; }
  });
  var supabase = fakeSupabase(function() { return { data: [{ id: UID }], error: null }; });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var id = await billing.resolveStripeCustomer({ id: UID, email: 'shared@home.net', stripe_customer_id: null });
  assert.strictEqual(id, 'cus_fresh', 'email-only match must never be adopted');
  var warns = joinedCalls(con.warn);
  assert.match(warns, /email-only Stripe customer cus_email_only/);
  assert.match(warns, /NOT adopted/);
});

test('resolveStripeCustomer: create path passes idempotencyKey cust-create-<uuid>', async function(t) {
  silenceConsole(t);
  var stripe = fakeStripe();
  var supabase = fakeSupabase(function() { return { data: [{ id: UID }], error: null }; });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  await billing.resolveStripeCustomer({ id: UID, email: 'a@b.c', stripe_customer_id: null });
  var create = stripe.calls.find(function(c) { return c[0] === 'customers.create'; });
  assert.ok(create, 'customer created');
  assert.strictEqual(create[2].idempotencyKey, 'cust-create-' + UID);
  assert.strictEqual(create[1].metadata.user_id, UID);
});

// ---- applySubscriptionProfileUpdate ---------------------------------------

var SUB = { id: 'sub_123', customer: 'cus_123', metadata: { user_id: UID } };
var FIELDS = { subscription_status: 'canceled' };

test('applySubscriptionProfileUpdate: sub-ID match takes path 1, no fallback logs', async function(t) {
  var con = silenceConsole(t);
  var supabase = fakeSupabase(function(q) {
    assert.ok(hasFilter(q, 'eq', 'stripe_subscription_id', 'sub_123'));
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  await billing.applySubscriptionProfileUpdate(SUB, FIELDS, 'test');
  assert.strictEqual(supabase.calls.length, 1);
  assert.strictEqual(con.warn.mock.calls.length, 0, 'no fallback fired');
  assert.strictEqual(con.error.mock.calls.length, 0);
});

test('applySubscriptionProfileUpdate: sub-ID miss + metadata hit backfills both IDs (path 2)', async function(t) {
  var con = silenceConsole(t);
  var supabase = fakeSupabase(function(q) {
    if (hasFilter(q, 'eq', 'stripe_subscription_id', 'sub_123')) return { data: [], error: null }; // path 1 miss
    assert.ok(hasFilter(q, 'eq', 'id', UID), 'path 2 targets metadata user');
    assert.strictEqual(q.fields.stripe_subscription_id, 'sub_123');
    assert.strictEqual(q.fields.stripe_customer_id, 'cus_123');
    assert.strictEqual(q.fields.subscription_status, 'canceled');
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  await billing.applySubscriptionProfileUpdate(SUB, FIELDS, 'test');
  assert.match(joinedCalls(con.warn), /METADATA fallback/);
});

test('applySubscriptionProfileUpdate: metadata absent, customer hit on NULL-sub profile (path 3)', async function(t) {
  var con = silenceConsole(t);
  var noMetaSub = { id: 'sub_123', customer: 'cus_123', metadata: {} };
  var supabase = fakeSupabase(function(q) {
    if (q.op === 'update' && hasFilter(q, 'eq', 'stripe_subscription_id', 'sub_123')) return { data: [], error: null };
    if (q.op === 'select' && hasFilter(q, 'eq', 'stripe_customer_id', 'cus_123')) {
      return { data: { id: 'u9-profile-id', stripe_subscription_id: null }, error: null };
    }
    // path 3 tolerant write
    assert.strictEqual(q.op, 'update');
    assert.ok(hasFilter(q, 'eq', 'id', 'u9-profile-id'));
    assert.ok(hasFilter(q, 'is', 'stripe_subscription_id', null), 'NULL re-asserted at write time');
    assert.strictEqual(q.fields.stripe_subscription_id, 'sub_123');
    return { data: [{ id: 'u9-profile-id' }], error: null };
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  await billing.applySubscriptionProfileUpdate(noMetaSub, FIELDS, 'test');
  assert.match(joinedCalls(con.warn), /CUSTOMER fallback/);
});

test('applySubscriptionProfileUpdate: customer profile linked to a DIFFERENT sub is refused — status unchanged', async function(t) {
  var con = silenceConsole(t);
  var noMetaSub = { id: 'sub_OLD', customer: 'cus_123', metadata: {} };
  var supabase = fakeSupabase(function(q) {
    if (q.op === 'update' && hasFilter(q, 'eq', 'stripe_subscription_id', 'sub_OLD')) return { data: [], error: null };
    if (q.op === 'select') return { data: { id: 'u9-profile-id', stripe_subscription_id: 'sub_CURRENT' }, error: null };
    assert.fail('no write may target the profile: got ' + JSON.stringify(q));
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  await billing.applySubscriptionProfileUpdate(noMetaSub, FIELDS, 'test');
  var updates = supabase.calls.filter(function(q) { return q.op === 'update'; });
  assert.strictEqual(updates.length, 1, 'only the path-1 probe ran');
  assert.match(joinedCalls(con.warn), /refusing to apply event for sub sub_OLD/);
});

test('applySubscriptionProfileUpdate: all three paths miss — ERROR logged, no write', async function(t) {
  var con = silenceConsole(t);
  var noMetaSub = { id: 'sub_123', customer: 'cus_123', metadata: {} };
  var supabase = fakeSupabase(function(q) {
    if (q.op === 'update') return { data: [], error: null };
    return { data: null, error: null }; // no profile for the customer either
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  await billing.applySubscriptionProfileUpdate(noMetaSub, FIELDS, 'test');
  var updates = supabase.calls.filter(function(q) { return q.op === 'update'; });
  assert.strictEqual(updates.length, 1, 'only the path-1 probe ran');
  assert.match(joinedCalls(con.error), /could NOT route sub sub_123/);
});

// ---- updateProfileTolerant -------------------------------------------------

test('updateProfileTolerant: clean write', async function(t) {
  silenceConsole(t);
  var supabase = fakeSupabase(function(q) {
    assert.strictEqual(q.fields.subscription_status, 'past_due');
    assert.strictEqual(q.fields.stripe_customer_id, 'cus_1');
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  var r = await billing.updateProfileTolerant({
    userId: UID,
    safeFields: { subscription_status: 'past_due' },
    idFields: { stripe_customer_id: 'cus_1' },
    label: 'test'
  });
  assert.deepStrictEqual(r, { persisted: true, matched: 1, idsDropped: false });
});

test('updateProfileTolerant: conflict logs both profile IDs, retries safeFields only, does not throw', async function(t) {
  var con = silenceConsole(t);
  var supabase = fakeSupabase(function(q) {
    if (q.op === 'update' && 'stripe_customer_id' in (q.fields || {})) {
      return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
    }
    if (q.op === 'select' && hasFilter(q, 'eq', 'stripe_customer_id', 'cus_1')) {
      return { data: { id: 'other-profile-id', email: 'other@x.com' }, error: null };
    }
    // safeFields-only retry
    assert.strictEqual(q.op, 'update');
    assert.ok(!('stripe_customer_id' in q.fields), 'retry must drop the id field');
    assert.strictEqual(q.fields.subscription_status, 'past_due');
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: fakeStripe(), supabase: supabase });

  var r = await billing.updateProfileTolerant({
    userId: UID,
    safeFields: { subscription_status: 'past_due' },
    idFields: { stripe_customer_id: 'cus_1' },
    label: 'test'
  });
  assert.deepStrictEqual(r, { persisted: true, matched: 1, idsDropped: true });
  var warns = joinedCalls(con.warn);
  assert.match(warns, /already belongs to profile other-profile-id/);
  assert.match(warns, new RegExp('wanted it on profile ' + UID));
});

test('portal flow: persistence conflict does not block the portal session', async function(t) {
  silenceConsole(t);
  var stripe = fakeStripe({ create: function() { return { id: 'cus_new' }; } });
  var supabase = fakeSupabase(function(q) {
    if (q.op === 'update') return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
    return { data: null, error: null }; // owner lookup finds nothing
  });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var r = await billing.openBillingPortal({ id: UID, email: 'a@b.c', stripe_customer_id: null }, 'https://x/dashboard');
  assert.strictEqual(r.url, 'https://billing.stripe.com/session/test');
  var portal = stripe.calls.find(function(c) { return c[0] === 'portal.create'; });
  assert.strictEqual(portal[1].customer, 'cus_new');
  assert.strictEqual(portal[1].return_url, 'https://x/dashboard');
});

// ---- portal CAS sync -------------------------------------------------------

var PAST_DUE_PROFILE = {
  id: UID, email: 'a@b.c', stripe_customer_id: 'cus_1',
  stripe_subscription_id: null, subscription_status: 'past_due'
};
var LIVE_SUB = { id: 'sub_live', status: 'active', cancel_at_period_end: false, cancel_at: null };

test('portal CAS: priorStatus still current — sync write lands', async function(t) {
  silenceConsole(t);
  var stripe = fakeStripe({ subsList: function(p) {
    assert.strictEqual(p.status, 'all', 'must list subscriptions with status:all');
    return { data: [LIVE_SUB] };
  } });
  var supabase = fakeSupabase(function(q) {
    assert.strictEqual(q.op, 'update');
    assert.ok(hasFilter(q, 'eq', 'id', UID));
    assert.ok(hasFilter(q, 'eq', 'subscription_status', 'past_due'), 'CAS on the status read at request start');
    assert.strictEqual(q.fields.subscription_status, 'active');
    assert.strictEqual(q.fields.stripe_subscription_id, 'sub_live');
    return { data: [{ id: UID }], error: null };
  });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var r = await billing.openBillingPortal(PAST_DUE_PROFILE, 'https://x/dashboard');
  assert.strictEqual(r.url, 'https://billing.stripe.com/session/test');
  assert.strictEqual(supabase.calls.filter(function(q) { return q.op === 'update'; }).length, 1, 'sync write happened');
});

test('portal CAS: status changed underneath — 0 rows, "webhook won" logged, portal URL still returned', async function(t) {
  var con = silenceConsole(t);
  var stripe = fakeStripe({ subsList: function() { return { data: [LIVE_SUB] }; } });
  var supabase = fakeSupabase(function(q) {
    assert.ok(hasFilter(q, 'eq', 'subscription_status', 'past_due'));
    return { data: [], error: null }; // CAS matched nothing — a webhook moved it
  });
  var billing = createBilling({ stripe: stripe, supabase: supabase });

  var r = await billing.openBillingPortal(PAST_DUE_PROFILE, 'https://x/dashboard');
  assert.strictEqual(r.url, 'https://billing.stripe.com/session/test');
  assert.match(joinedCalls(con.log), /webhook won/);
});
