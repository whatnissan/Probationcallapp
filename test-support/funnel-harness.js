// Boots the REAL server.js offline for test/funnel-endpoints.test.js (kept
// outside test/ so `node --test` does not run it on its own).
//
// Fake Supabase with just the tables these endpoints touch, two bearer
// tokens (an ordinary user and an admin), network refused, no crons fired.
// Prints one JSON line of observations and exits.
'use strict';
const Module = require('module'), http = require('http'), path = require('path');
const REPO = path.join(__dirname, '..');

const id = (n) => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const U = { PERSON: id(21), ADMIN: id(22) };
const prof = (uid, extra) => Object.assign({ id: uid, email: uid.slice(-2) + '@example.invalid',
  credits: 0, is_demo: false, is_admin: false, is_disabled: false }, extra || {});
const tables = {
  profiles: [prof(U.PERSON), prof(U.ADMIN, { is_admin: true })],
  funnel_events: [],
  promo_codes: [{ id: 'pc1', code: 'PARTNER1', credits: 5, times_used: 0, max_uses: 10,
                  expires_at: null, affiliate_id: null }],
  promo_redemptions: [],
  credit_transactions: [], call_history: [], schema_migrations: []
};
let seq = 1;
function builder(table) {
  const f = []; const orders = []; let op = null, payload = null, single = false, lim = null;
  const rows = () => (tables[table] = tables[table] || []);
  const b = new Proxy({}, { get(_t, p) {
    if (p === 'then') return (res, rej) => {
      const match = (r) => f.every((t) => t(r));
      let out;
      if (op === 'insert' || op === 'upsert') {
        const items = (Array.isArray(payload) ? payload : [payload])
          .map((it) => Object.assign({ id: '00000000-0000-4000-9000-' + String(seq++).padStart(12, '0'),
                                       created_at: new Date().toISOString() }, it));
        rows().push(...items);
        out = { data: single ? items[0] : items, error: null };
      } else if (op === 'update') {
        const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, payload));
        out = { data: hit.map((r) => Object.assign({}, r)), error: null };
      } else if (op === 'delete') {
        tables[table] = rows().filter((r) => !match(r));
        out = { data: null, error: null };
      } else {
        let got = rows().filter(match);
        for (const [c, asc] of orders.slice().reverse()) {
          got = got.slice().sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (lim !== null) got = got.slice(0, lim);
        out = single ? { data: got[0] ? Object.assign({}, got[0]) : null, error: null }
                     : { data: got.map((r) => Object.assign({}, r)), error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    if (['insert', 'update', 'upsert', 'delete'].includes(p)) return (x) => { op = p; payload = x; return b; };
    if (p === 'select') return () => b;
    if (p === 'single' || p === 'maybeSingle') return () => { single = true; return b; };
    const cmp = { eq: (a, v) => String(a) === String(v), gte: (a, v) => a >= v, lte: (a, v) => a <= v };
    if (cmp[p]) return (c, v) => { f.push((r) => r[c] !== undefined && r[c] !== null && cmp[p](r[c], v)); return b; };
    if (p === 'is') return (c, v) => { f.push((r) => (r[c] === undefined ? null : r[c]) === v); return b; };
    if (p === 'in') return (c, vs) => { f.push((r) => vs.map(String).includes(String(r[c]))); return b; };
    if (p === 'order') return (c, o) => { orders.push([c, !(o && o.ascending === false)]); return b; };
    if (p === 'limit') return (n) => { lim = n; return b; };
    return () => b;
  }});
  return b;
}
const tokens = { 'tok-person': U.PERSON, 'tok-admin': U.ADMIN };
const fake = {
  from: builder,
  rpc: async (name, a) => {
    if (name === 'add_credits_with_ledger') {
      const p = tables.profiles.find((r) => r.id === a.p_user_id);
      p.credits += a.p_amount;
      tables.credit_transactions.push({ id: 'l' + (seq++), user_id: a.p_user_id, amount: a.p_amount, source: a.p_source });
      return { data: p.credits, error: null };
    }
    return { data: null, error: null };
  },
  auth: {
    getUser: async (t) => tokens[t]
      ? { data: { user: { id: tokens[t], email: (tables.profiles.find((p) => p.id === tokens[t]) || {}).email } }, error: null }
      : { data: { user: null }, error: { message: 'bad' } },
    admin: new Proxy({}, { get: () => async () => ({ data: null, error: null }) })
  },
  storage: { from: () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
  channel: () => new Proxy({}, { get: () => function () { return this; } })
};
const inert = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : inert(), apply: () => inert() });
const L = Module._load;
Module._load = function (r) {
  if (r === 'dotenv') return { config: () => ({}) };
  if (r === '@supabase/supabase-js') return { createClient: () => fake };
  if (r === 'twilio') return new Proxy(function () { return inert(); }, { get: () => inert() });
  if (r === 'stripe') return () => inert();
  if (r === 'node-cron') return { schedule: () => ({ start() {}, stop() {} }), validate: () => true };
  if (/(^|\/)lib\/apns(\.js)?$/.test(r)) {
    return { apnsConfigured: () => false, buildPayload: (o) => o, sendPush: async () => ({ ok: true }),
             sendPushBothEnvironments: async () => ({ ok: true, unregistered: false }) };
  }
  return L.apply(this, arguments);
};
globalThis.fetch = async (u) => { throw new Error('blocked fetch ' + u); };
Object.assign(process.env, { BASE_URL: 'https://example.invalid', BREVO_KEY: 'x', TWILIO_VALIDATE: 'off',
                             NODE_ENV: 'test', PORT: '3917' });
console.log = () => {}; console.error = () => {}; console.warn = () => {};
require(path.join(REPO, 'server.js'));

const call = (method, p, body, tok) => new Promise((ok) => {
  const s = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port: 3917, path: p, method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
                           tok ? { Authorization: 'Bearer ' + tok } : {}) },
    (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
      let j = null; try { j = JSON.parse(d); } catch (e) {}
      ok({ status: res.statusCode, j });
    }); });
  req.end(s);
});

setTimeout(async () => {
  const out = { rows: tables.funnel_events };
  const rowsFor = (name) => tables.funnel_events.filter((r) => r.name === name);
  try {
    const asked = await call('POST', '/api/v1/events', { name: 'onboarding_partner_asked' }, 'tok-person');
    out.asked = { status: asked.status, recorded: asked.j && asked.j.recorded, rows: rowsFor('onboarding_partner_asked').length,
                  userId: rowsFor('onboarding_partner_asked')[0] && rowsFor('onboarding_partner_asked')[0].user_id };

    const answered = await call('POST', '/api/v1/events',
      { name: 'onboarding_partner_answered', props: { answer: 'yes', junk: 'x' } }, 'tok-person');
    out.answered = { status: answered.status, props: rowsFor('onboarding_partner_answered')[0] &&
      rowsFor('onboarding_partner_answered')[0].props };

    const unknown = await call('POST', '/api/v1/events', { name: 'onboarding_partner_nope' }, 'tok-person');
    out.unknown = { status: unknown.status, recorded: unknown.j && unknown.j.recorded, rows: rowsFor('onboarding_partner_nope').length };

    const serverOnly = await call('POST', '/api/v1/events', { name: 'redeem_success', props: { credits: 5 } }, 'tok-person');
    out.serverOnly = { status: serverOnly.status, recorded: serverOnly.j && serverOnly.j.recorded };

    const noAuth = await call('POST', '/api/v1/events', { name: 'onboarding_partner_asked' });
    out.noAuth = noAuth.status;

    const open = await call('POST', '/api/v1/events/open', { src: 'ios-onboarding' });
    out.open = { status: open.status, row: rowsFor('redeem_page_open')[0] };
    const openBad = await call('POST', '/api/v1/events/open', { src: '<script>' });
    out.openBad = rowsFor('redeem_page_open')[1] && rowsFor('redeem_page_open')[1].src;

    const redeem = await call('POST', '/api/v1/redeem', { code: 'PARTNER1', src: 'ios-onboarding' }, 'tok-person');
    out.redeem = { status: redeem.status, success: rowsFor('redeem_success')[0] };
    const bad = await call('POST', '/api/v1/redeem', { code: 'NOPE99', src: 'ios-onboarding' }, 'tok-person');
    out.bad = { status: bad.status, failed: rowsFor('redeem_failed')[0] };

    const summary = await call('GET', '/api/admin/funnel?days=7', null, 'tok-admin');
    out.summary = { status: summary.status, totals: summary.j && summary.j.totals, srcs: summary.j && summary.j.srcs,
                    failures: summary.j && summary.j.failures, rates: summary.j && summary.j.rates,
                    days: summary.j && summary.j.byDay };
    const summaryNoAuth = await call('GET', '/api/admin/funnel?days=7');
    out.summaryNoAuth = summaryNoAuth.status;
  } catch (e) {
    out.error = e.stack;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}, 1500);
