// Boots the REAL server.js offline for test/push-preference.test.js (kept
// outside test/ so `node --test` does not run it on its own):
// fake Supabase (in memory), fake Twilio (records dials), fake node-cron
// (captures every job so the test can fire it), network refused except two
// stubs (finishprobation.com for Fort Bend, Brevo for email), clock pinned to
// 09:00 Central — inside the Montgomery window, before the retry cutoff.
// Prints one JSON line of observations and exits.
'use strict';
const Module = require('module'), http = require('http'), https = require('https'), path = require('path');
const REPO = path.join(__dirname, '..');

const NOW = Date.parse('2026-10-28T14:00:00Z');
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

const id = (n) => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const U = { PO: id(11), PR: id(12), PS: id(13), PN: id(14), PU: id(15), G: id(16), ADMIN: id(17) };
const prof = (uid, extra) => Object.assign({ id: uid, email: uid.slice(-2) + '@example.invalid', credits: 10, is_demo: false, is_admin: false, is_disabled: false, user_color: 'gray', verified_phone: null }, extra || {});
const phone = (uid) => '+1555555' + uid.slice(-4);
const ft = (uid, push) => ({ id: 's' + uid.slice(-2), user_id: uid, county: 'ftbend', ftbend_office: 'missouri', target_number: '+12812383669', pin: null,
  hour: 5, minute: 10, timezone: 'America/Chicago', enabled: true, paused_reason: null, notify_method: 'sms', notify_email: null,
  notify_number: phone(uid), notify_push: push, quiet_mode: false, created_at: '2026-09-01T00:00:00Z' });
const daysAgo = (n) => new RealDate(NOW - n * 86400000).toISOString();
const dev = (uid, tok, days) => ({ id: 'd' + tok, user_id: uid, token: tok, environment: 'production', last_seen_at: daysAgo(days), unregistered_at: null });
const tables = {
  profiles: [prof(U.PO), prof(U.PR), prof(U.PS), prof(U.PN), prof(U.PU), prof(U.G), prof(U.ADMIN, { is_admin: true })],
  user_schedules: [ft(U.PO, false), ft(U.PR, true), ft(U.PS, true), ft(U.PN, true), ft(U.PU, true),
    { id: 'sG', user_id: U.G, county: 'montgomery', target_number: '+19362834848', pin: '654321', hour: 6, minute: 30, timezone: 'America/Chicago',
      enabled: true, paused_reason: null, notify_method: 'email', notify_email: 'g@example.invalid', notify_number: null, notify_push: true, quiet_mode: false, created_at: '2026-09-01T00:00:00Z' }],
  device_tokens: [dev(U.PO, 'tokPO', 1), dev(U.PR, 'tokPR1', 1), dev(U.PR, 'tokPR2', 9), dev(U.PS, 'tokPS', 20), dev(U.PU, 'tokPU', 2)],
  pending_retries: [], credit_transactions: [], call_history: [], call_attempts: [], sms_opt_outs: [], sms_consents: [], schema_migrations: [], push_deliveries: []
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
        const items = (Array.isArray(payload) ? payload : [payload]).map((it) => Object.assign({ id: '00000000-0000-4000-9000-' + String(seq++).padStart(12, '0') }, it));
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
const tokens = { 'tok-po': U.PO, 'tok-pr': U.PR, 'tok-ps': U.PS, 'tok-g': U.G, 'tok-admin': U.ADMIN };
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
const pushes = [];
const fakeApns = {
  apnsConfigured: () => true,
  buildPayload: (o) => o,
  sendPush: async () => ({ ok: true }),
  sendPushBothEnvironments: async (_fn, o) => { pushes.push(o.token); return { ok: true, apnsId: 'apns-' + o.token, attempts: [], unregistered: false }; }
};
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
  if (/(^|\/)lib\/apns(\.js)?$/.test(r)) return fakeApns;
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
Object.assign(process.env, { BASE_URL: 'https://example.invalid', BREVO_KEY: 'x', TWILIO_VALIDATE: 'off', NODE_ENV: 'test', PUSH_PREF_MIN_BUILD: '25' });
console.log = () => {}; console.error = () => {}; console.warn = () => {};
require(path.join(REPO, 'server.js'));

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (method, p, body, tok, ua) => new Promise((ok) => {
  const s = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), path: p, method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }, tok ? { Authorization: 'Bearer ' + tok } : {}, ua ? { 'User-Agent': ua } : {}) },
    (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} ok({ status: res.statusCode, j, raw: d }); }); });
  req.end(s);
});
const minuteCron = () => crons.find((c) => c.expr === '* * * * *');
const pushesFor = (...toks) => pushes.filter((x) => toks.includes(x)).length;
const textsTo = (uid) => smsSent.filter((m) => m.to === phone(uid)).length;
const delivery = (uid) => tables.push_deliveries.find((r) => r.user_id === uid) || {};
const sched = (uid) => tables.user_schedules.find((r) => r.user_id === uid);

setTimeout(async () => {
  const out = {};
  try {
    // The morning: Fort Bend's answer is queued for everyone, then delivered.
    const pop = await call('POST', '/api/admin/ftbend-populate-from-truth', { office: 'missouri' }, 'tok-admin');
    out.populate = pop.status;
    await minuteCron().fn(); await tick(400);

    out.off = { pushes: pushesFor('tokPO'), textsNow: textsTo(U.PO), reason: delivery(U.PO).fallback_reason || null };
    out.twoDevices = { pushes: pushesFor('tokPR1', 'tokPR2'), accepted: delivery(U.PR).accepted_count, textsNow: textsTo(U.PR), held: !!delivery(U.PR).fallback_due_at && !delivery(U.PR).fallback_sent_at };
    out.staleOnly = { pushes: pushesFor('tokPS'), textsNow: textsTo(U.PS), reason: delivery(U.PS).fallback_reason || null, accepted: delivery(U.PS).accepted_count };
    out.noDevice = { pushes: 0, textsNow: textsTo(U.PN), reason: delivery(U.PN).fallback_reason || null };

    // The hold: PR acknowledges from one device; PU does not. Then the hold runs out.
    const ack = await call('POST', '/api/v1/push/' + delivery(U.PR).id + '/ack', {}, 'tok-pr');
    out.ackStatus = ack.status;
    [U.PR, U.PU].forEach((u) => { delivery(u).fallback_due_at = new RealDate(NOW - 60000).toISOString(); });
    await minuteCron().fn(); await tick(300);
    out.afterHold = { ackedTexts: textsTo(U.PR), unackedTexts: textsTo(U.PU) };

    // Devices: which would get tomorrow's result.
    const dv = async (tok) => ((await call('GET', '/api/v1/devices', null, tok)).j.devices || []).map((d) => d.token + ':' + d.receivesResults);
    out.devices = { PR: await dv('tok-pr'), PS: await dv('tok-ps'), PO: await dv('tok-po') };
    const me = async (tok) => (((await call('GET', '/api/v1/me', null, tok)).j || {}).schedules || [])[0];
    out.meNotifyMethods = { PO: (await me('tok-po') || {}).notifyMethods, PR: (await me('tok-pr') || {}).notifyMethods };

    // THE BUILD GATE, through PUT /schedule (PUSH_PREF_MIN_BUILD=25).
    const body = (methods) => ({ county: 'montgomery', pin: '654321', callTime: '06:30', timezone: 'America/Chicago',
      notifyMethods: methods, notifyEmail: 'g@example.invalid', quietMode: false });
    const ua = (b) => 'probationcall/' + b + ' CFNetwork/1498.700.2 Darwin/24.0.0';
    const r24 = await call('PUT', '/api/v1/schedule', body(['email']), 'tok-g', ua(24));
    out.gate = { b24Status: r24.status, b24Err: r24.j && r24.j.error ? r24.j.error.code + ':' + (r24.j.error.field || '') : null, afterBuild24WithoutPush: sched(U.G).notify_push };
    const r25 = await call('PUT', '/api/v1/schedule', body(['email']), 'tok-g', ua(25));
    out.gate.b25Status = r25.status; out.gate.afterBuild25WithoutPush = sched(U.G).notify_push;
    out.gate.build25ResponseMethods = r25.j && r25.j.notifyMethods;
    await call('PUT', '/api/v1/schedule', body(['push', 'email']), 'tok-g', ua(24));
    out.gate.afterBuild24WithPush = sched(U.G).notify_push;
    await call('PUT', '/api/v1/schedule', body(['email']), 'tok-g', null);
    out.gate.afterNoBuildWithoutPush = sched(U.G).notify_push;
  } catch (e) {
    out.error = e.stack;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}, 1200);
