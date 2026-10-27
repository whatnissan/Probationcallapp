// Boots the REAL server.js offline for test/pause-stops-calls.test.js (kept
// outside test/ so `node --test` does not run it on its own):
// fake Supabase (in memory), fake Twilio (records dials), fake node-cron
// (captures every job so the test can fire it), network refused except two
// stubs (finishprobation.com for Fort Bend, Brevo for email), clock pinned to
// 09:00 Central — inside the Montgomery window, before the retry cutoff.
// Prints one JSON line of observations and exits.
'use strict';
const Module = require('module'), http = require('http'), https = require('https'), path = require('path');
const REPO = path.join(__dirname, '..');

const NOW = Date.parse('2026-10-27T14:00:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
};
for (const mod of [http, https]) {
  const o = mod.request;
  mod.request = function (opts, ...r) {
    const h = typeof opts === 'string' ? new URL(opts).hostname : (opts.hostname || opts.host);
    if (h && !['localhost', '127.0.0.1', '::1'].includes(h)) throw new Error('blocked ' + h);
    return o.call(this, opts, ...r);
  };
}

const MG = '+19362834848';
const id = (n) => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const U = { M1: id(1), M2: id(2), R1: id(3), R2: id(4), S1: id(5), F1: id(6), F2: id(7), ADMIN: id(8), F3: id(9) };
const prof = (uid, extra) => Object.assign({ id: uid, email: uid.slice(-2) + '@example.invalid', credits: 10, is_demo: false, is_admin: false, is_disabled: false }, extra || {});
const mgSched = (uid, minute, extra) => Object.assign({ id: 's' + uid.slice(-2), user_id: uid, county: 'montgomery', target_number: MG, pin: '1234' + uid.slice(-2),
  hour: 6, minute: minute, timezone: 'America/Chicago', enabled: true, paused_reason: null, notify_method: 'email', notify_email: uid.slice(-2) + '@example.invalid',
  notify_number: null, created_at: '2026-09-01T00:00:00Z' }, extra || {});
const ftSched = (uid, enabled) => ({ id: 's' + uid.slice(-2), user_id: uid, county: 'ftbend', ftbend_office: 'missouri', target_number: '+12812383669', pin: null,
  hour: 5, minute: 10, timezone: 'America/Chicago', enabled: enabled, paused_reason: enabled ? null : 'user', notify_method: 'email',
  notify_email: uid.slice(-2) + '@example.invalid', notify_number: null, created_at: '2026-09-01T00:00:00Z' });

const tables = {
  profiles: [prof(U.M1), prof(U.M2), prof(U.R1), prof(U.R2), prof(U.S1, { email: null }), prof(U.F1, { user_color: 'gray' }), prof(U.F2, { user_color: 'gray' }), prof(U.ADMIN, { is_admin: true }), prof(U.F3, { user_color: 'gray' })],
  user_schedules: [mgSched(U.M1, 0), mgSched(U.M2, 5), mgSched(U.R1, 10), mgSched(U.R2, 15),
    mgSched(U.S1, 20, { notify_method: 'sms', notify_email: null, notify_number: '+15555550105' }), ftSched(U.F1, true), ftSched(U.F2, false), ftSched(U.F3, true)],
  pending_retries: [], credit_transactions: [], call_history: [], call_attempts: [], sms_opt_outs: [], sms_consents: [], schema_migrations: []
};
let seq = 1;
function builder(table) {
  const f = []; const orders = []; let op = null, payload = null, single = false, lim = null, head = false, count = false;
  const rows = () => (tables[table] = tables[table] || []);
  const b = new Proxy({}, { get(_t, p) {
    if (p === 'then') return (res, rej) => {
      const match = (r) => f.every((t) => t(r));
      let out;
      if (op === 'insert' || op === 'upsert') {
        const items = (Array.isArray(payload) ? payload : [payload]).map((it) => Object.assign({ id: 'r' + (seq++) }, it));
        rows().push(...items);
        out = { data: single ? items[0] : items, error: null };
      } else if (op === 'update') {
        const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, payload));
        out = { data: hit.map((r) => Object.assign({}, r)), error: null };
      } else if (op === 'delete') {
        const keep = rows().filter((r) => !match(r)); const gone = rows().length - keep.length; tables[table] = keep;
        out = { data: null, error: null, count: gone };
      } else {
        let got = rows().filter(match);
        for (const [c, asc] of orders.slice().reverse()) got = got.slice().sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1));
        const n = got.length;
        if (lim !== null) got = got.slice(0, lim);
        out = single ? { data: got[0] ? Object.assign({}, got[0]) : null, error: null } : { data: head ? null : got.map((r) => Object.assign({}, r)), error: null, count: count ? n : null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    if (['insert', 'update', 'upsert', 'delete'].includes(p)) return (x) => { op = p; payload = x; return b; };
    if (p === 'select') return (_c, o) => { if (o && o.head) head = true; if (o && o.count) count = true; return b; };
    if (p === 'single' || p === 'maybeSingle') return () => { single = true; return b; };
    const cmp = { eq: (a, v) => String(a) === String(v), neq: (a, v) => String(a) !== String(v), lte: (a, v) => a <= v, gte: (a, v) => a >= v, lt: (a, v) => a < v, gt: (a, v) => a > v };
    if (cmp[p]) return (c, v) => { f.push((r) => r[c] !== undefined && r[c] !== null && cmp[p](r[c], v)); return b; };
    if (p === 'is') return (c, v) => { f.push((r) => (r[c] === undefined ? null : r[c]) === v); return b; };
    if (p === 'not') return (c, o, v) => { f.push((r) => !(o === 'is' && (r[c] === undefined ? null : r[c]) === v)); return b; };
    if (p === 'in') return (c, vs) => { f.push((r) => vs.map(String).includes(String(r[c]))); return b; };
    if (p === 'order') return (c, o) => { orders.push([c, !(o && o.ascending === false)]); return b; };
    if (p === 'limit') return (n) => { lim = n; return b; };
    return () => b;
  }});
  return b;
}
const P = (uid) => tables.profiles.find((r) => r.id === uid);
const rpc = async (name, a) => {
  if (name === 'deduct_credit_with_ledger') {
    const p = P(a.p_user_id); p.credits -= a.p_amount;
    tables.credit_transactions.push({ id: 'l' + (seq++), user_id: a.p_user_id, amount: -a.p_amount, source: a.p_source || 'call_deduction' });
    return { data: p.credits, error: null };
  }
  if (name === 'add_credits_with_ledger') { const p = P(a.p_user_id); p.credits += a.p_amount; return { data: p.credits, error: null }; }
  return { data: null, error: null };
};
const tokens = { 'tok-m1': U.M1, 'tok-r1': U.R1, 'tok-admin': U.ADMIN, 'tok-f3': U.F3 };
const fake = { from: builder, rpc,
  auth: { getUser: async (t) => tokens[t] ? { data: { user: { id: tokens[t], email: P(tokens[t]).email } }, error: null } : { data: { user: null }, error: { message: 'bad' } },
          admin: new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
  storage: { from: () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
  channel: () => new Proxy({}, { get: () => function () { return this; } }) };

const dials = []; const smsSent = []; const emails = [];
const twilioClient = {
  calls: { create: async (o) => { dials.push({ to: o.to }); return { sid: 'CA' + (seq++) }; } },
  messages: { create: async (o) => { smsSent.push({ to: o.to }); return { sid: 'SM' + (seq++), status: 'queued' }; } },
  calls_get: null
};
const twilioFn = new Proxy(function () { return twilioClient; }, { get: (t, k) => k === 'validateRequest' ? () => true : (k === 'twiml' ? require(path.join(REPO, 'node_modules', 'twilio')).twiml : t[k]) });
const crons = [];
const fakeCron = { schedule: (expr, fn) => { const job = { expr, fn, stopped: false, stop() { this.stopped = true; }, start() {} }; crons.push(job); return job; }, validate: () => true };
const inert = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : inert(), apply: () => inert() });
const L = Module._load;
Module._load = function (r, p, m) {
  if (r === 'dotenv') return { config: () => ({}) };
  if (r === '@supabase/supabase-js') return { createClient: () => fake };
  if (r === 'twilio') return twilioFn;
  if (r === 'stripe') return () => inert();
  if (r === 'node-cron') return fakeCron;
  return L.apply(this, arguments);
};
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (u.includes('brevo')) { emails.push(JSON.parse(o.body).to[0].email); return { ok: true, status: 201, json: async () => ({ messageId: 'm' }), text: async () => '' }; }
  if (u.includes('finishprobation.com')) {
    const data = { props: { pageProps: { releases: [{ createdAt: new RealDate(NOW).toISOString(), testGroups: ['Gray'], phoneRecording: 'gray' }] } } };
    return { ok: true, status: 200, text: async () => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(data) + '</script>' };
  }
  throw new Error('blocked fetch ' + u);
};
Object.assign(process.env, { BASE_URL: 'https://example.invalid', BREVO_KEY: 'x', TWILIO_VALIDATE: 'off', NODE_ENV: 'test' });
console.log = () => {}; console.error = () => {}; console.warn = () => {};
require(path.join(REPO, 'server.js'));

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (method, p, body, tok, form) => new Promise((ok) => {
  const s = body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : '';
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), path: p, method,
    headers: Object.assign({ 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(s) }, tok ? { Authorization: 'Bearer ' + tok } : {}) },
    (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => ok({ status: res.statusCode, body: d })); });
  req.end(s);
});
const jobFor = (minute) => crons.find((c) => c.expr === minute + ' 6 * * *');
const minuteCron = () => crons.find((c) => c.expr === '* * * * *');
const charges = (uid) => tables.credit_transactions.filter((t) => t.user_id === uid && t.amount < 0).length;
const sched = (uid) => tables.user_schedules.find((r) => r.user_id === uid);
const retryRow = (uid, k) => ({ id: 'pr' + k, user_id: uid, county: 'montgomery', target_number: MG, pin: '123403', notify_number: null,
  notify_email: 'x@example.invalid', notify_method: 'email', attempt_number: 1, last_result: 'UNKNOWN', next_attempt_at: '2026-10-27T13:00:00Z' });

setTimeout(async () => {
  const out = {};
  try {
    // 1. Morning job: a paused user is not dialled.
    const m1 = jobFor(0), m2 = jobFor(5);
    out.jobsBuiltAtBoot = !!(m1 && m2);
    const pause = await call('POST', '/api/v1/schedule/pause', {}, 'tok-m1');
    out.pauseStatus = pause.status;
    out.pauseStoppedJob = m1.stopped;
    let before = dials.length;
    await m1.fn(); await tick(250);                 // a stale job firing anyway: the dial-time check must refuse
    out.pausedDials = dials.length - before;
    out.pausedCharges = charges(U.M1);
    before = dials.length;
    await m2.fn(); await tick(250);                 // control: an enabled user IS dialled by the same harness
    out.enabledDials = dials.length - before;

    // 2. Retry queue: a pause between queueing and firing stops the retry.
    tables.pending_retries.push(retryRow(U.R1, 1));
    tables.pending_retries.push(retryRow(U.R2, 2));
    await call('POST', '/api/v1/schedule/pause', {}, 'tok-r1');
    out.pauseClearedRetry = !tables.pending_retries.some((r) => r.user_id === U.R1);
    tables.pending_retries.push(retryRow(U.R1, 3));  // queued again after the pause (or the clear failed)
    before = dials.length;
    await minuteCron().fn(); await tick(250);
    out.retryDials = dials.length - before;          // R2 (enabled) should be the only dial
    out.pausedRetryLeft = tables.pending_retries.some((r) => r.user_id === U.R1);
    out.enabledRetryLeased = tables.pending_retries.some((r) => r.user_id === U.R2);

    // 3. STOP with no email: paused, not dialled, not charged — by the
    // morning job or by a retry queued earlier that morning.
    tables.pending_retries.push(Object.assign(retryRow(U.S1, 4), { notify_method: 'sms', notify_email: null, notify_number: '+15555550105' }));
    await call('POST', '/webhook/sms-incoming', { From: '+15555550105', Body: 'STOP' }, null, true);
    await tick(250);
    out.stopClearedRetry = !tables.pending_retries.some((r) => r.user_id === U.S1);
    tables.pending_retries.push(Object.assign(retryRow(U.S1, 5), { notify_method: 'sms', notify_email: null, notify_number: '+15555550105' }));
    before = dials.length;
    await minuteCron().fn(); await tick(250);
    out.stopRetryDials = dials.length - before;
    out.stopPause = { enabled: sched(U.S1).enabled, reason: sched(U.S1).paused_reason };
    const s1 = jobFor(20);
    out.stopStoppedJob = s1.stopped;
    const s1Credits = P(U.S1).credits;
    before = dials.length;
    await s1.fn(); await tick(250);
    out.stopDials = dials.length - before;
    out.stopCharges = charges(U.S1);
    out.stopCreditsUnchanged = P(U.S1).credits === s1Credits;

    // 4. Fort Bend: queued at the office's answer, delivered (and charged) at
    // each person's time. Paused before the answer: never queued. Paused
    // between queueing and delivery: not delivered, not charged.
    const ft = await call('POST', '/api/admin/ftbend-populate-from-truth', { office: 'missouri' }, 'tok-admin');
    out.ftStatus = ft.status;
    out.ftQueued = (tables.pending_notifications || []).map((r) => r.user_id === U.F1 ? 'F1' : r.user_id === U.F2 ? 'F2' : r.user_id === U.F3 ? 'F3' : '?').sort();
    await call('POST', '/api/v1/schedule/pause', {}, 'tok-f3');
    await minuteCron().fn(); await tick(300);
    out.ftEnabledRows = tables.call_history.filter((r) => r.user_id === U.F1).length;
    out.ftEnabledCharges = charges(U.F1);
    out.ftPausedBeforeRows = tables.call_history.filter((r) => r.user_id === U.F2).length;
    out.ftPausedBeforeCharges = charges(U.F2);
    out.ftPausedAfterQueueRows = tables.call_history.filter((r) => r.user_id === U.F3).length;
    out.ftPausedAfterQueueCharges = charges(U.F3);
    out.ftDials = dials.filter((d) => d.to !== MG).length;   // Fort Bend users are never dialled one by one
  } catch (e) {
    out.error = e.stack;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}, 1200);
